/**
 * 前端认证模块
 *
 * 功能:
 * - JWT Token 管理
 * - 登录/登出
 * - Token 自动刷新
 * - API 请求认证
 */

export class AuthService {
  constructor() {
    this.tokenKey = 'access_token';
    this.userKey = 'user';
    this.tokenRefreshTimer = null;
  }

  /**
   * 登录
   */
  async login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    this.setToken(data.access_token);
    this.setUser(data.user);
    this.startTokenRefresh();

    return data.user;
  }

  /**
   * 登出
   */
  async logout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: this.getAuthHeaders()
      });
    } catch (err) {
      // 忽略登出错误
    }

    this.clearAuth();
    window.location.href = '/login.html';
  }

  /**
   * 刷新 Token
   */
  async refreshToken() {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include'  // 发送 refresh token cookie
      });

      if (!res.ok) {
        throw new Error('Token refresh failed');
      }

      const data = await res.json();
      this.setToken(data.access_token);
      this.startTokenRefresh();

      return true;
    } catch (err) {
      this.clearAuth();
      window.location.href = '/login.html';
      return false;
    }
  }

  /**
   * 切换命名空间
   */
  async switchNamespace(namespaceId) {
    const res = await fetch('/api/auth/namespace', {
      method: 'PUT',
      headers: {
        ...this.getAuthHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ namespace_id: namespaceId })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to switch namespace');
    }

    const user = this.getUser();
    user.namespace_id = namespaceId;
    this.setUser(user);

    return true;
  }

  /**
   * 获取当前用户
   */
  async fetchCurrentUser() {
    const res = await fetch('/api/auth/me', {
      headers: this.getAuthHeaders()
    });

    if (!res.ok) {
      throw new Error('Failed to fetch user info');
    }

    const user = await res.json();
    this.setUser(user);
    return user;
  }

  /**
   * 设置 Token
   */
  setToken(token) {
    localStorage.setItem(this.tokenKey, token);
    this.scheduleTokenRefresh();
  }

  /**
   * 获取 Token
   */
  getToken() {
    return localStorage.getItem(this.tokenKey);
  }

  /**
   * 设置用户信息
   */
  setUser(user) {
    localStorage.setItem(this.userKey, JSON.stringify(user));
  }

  /**
   * 获取用户信息
   */
  getUser() {
    const userStr = localStorage.getItem(this.userKey);
    return userStr ? JSON.parse(userStr) : null;
  }

  /**
   * 获取认证头
   */
  getAuthHeaders() {
    const token = this.getToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  /**
   * 检查认证状态并返回用户信息
   */
  async checkAuth() {
    const user = this.getUser();
    const token = this.getToken();

    if (!user || !token) {
      throw new Error('Not authenticated');
    }

    // 如果用户信息中已有 role，直接返回（避免每次加载都发请求）
    if (user.role) {
      return user;
    }

    // 否则，验证 token 是否有效
    try {
      await this.fetchCurrentUser();
      return this.getUser();
    } catch (err) {
      throw new Error('Token expired');
    }
  }

  /**
   * 检查是否已认证
   */
  isAuthenticated() {
    return !!this.getToken();
  }

  /**
   * 清除认证信息
   */
  clearAuth() {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  /**
   * 安排 Token 刷新 (12 分钟后)
   */
  scheduleTokenRefresh() {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    // Token 有效期 15 分钟，提前 3 分钟刷新
    this.tokenRefreshTimer = setTimeout(() => {
      this.refreshToken();
    }, 12 * 60 * 1000);
  }

  /**
   * 启动 Token 刷新
   */
  startTokenRefresh() {
    this.scheduleTokenRefresh();
  }

  /**
   * 获取当前角色
   */
  getRole() {
    const user = this.getUser();
    return user?.role || null;
  }

  /**
   * 检查是否有指定角色
   */
  hasRole(...roles) {
    const role = this.getRole();
    return roles.includes(role);
  }

  /**
   * 检查是否是管理员
   */
  isAdmin() {
    return this.hasRole('admin');
  }

  /**
   * 检查是否是编辑者
   */
  isEditor() {
    return this.hasRole('admin', 'editor');
  }
}

/**
 * API 客户端
 *
 * 自动携带 JWT Token，处理 401 错误
 */
export class ApiClient {
  constructor(authService) {
    this.authService = authService;
    this.baseOptions = {
      credentials: 'include'
    };
  }

  /**
   * 通用请求方法
   */
  async request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : endpoint;

    const defaultHeaders = {
      'Content-Type': 'application/json',
      ...this.authService.getAuthHeaders()
    };

    const config = {
      ...this.baseOptions,
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      }
    };

    try {
      let res = await fetch(url, config);

      // 处理 401 - Token 过期
      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));

        if (data.code === 'TOKEN_EXPIRED' || data.code === 'NO_TOKEN') {
          // 尝试刷新 Token
          const refreshed = await this.authService.refreshToken();

          if (refreshed) {
            // 重试原请求
            config.headers['Authorization'] = `Bearer ${this.authService.getToken()}`;
            res = await fetch(url, config);
          }
        }
      }

      // 再次检查 401 (刷新失败或权限不足)
      if (res.status === 401) {
        this.authService.clearAuth();
        window.location.href = '/login.html';
        throw new Error('Authentication required');
      }

      // 处理 403
      if (res.status === 403) {
        const data = await res.json();
        throw new Error(data.error || 'Permission denied');
      }

      // 处理错误响应
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // 返回 JSON 或文本
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await res.json();
      }

      return await res.text();
    } catch (err) {
      if (err.message === 'Failed to fetch') {
        throw new Error('Network error - please check your connection');
      }
      throw err;
    }
  }

  /**
   * GET 请求
   */
  get(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;
    return this.request(url, { method: 'GET' });
  }

  /**
   * POST 请求
   */
  post(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  /**
   * PUT 请求
   */
  put(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  /**
   * DELETE 请求
   */
  delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }
}

// 创建全局实例
export const auth = new AuthService();
export const api = new ApiClient(auth);
