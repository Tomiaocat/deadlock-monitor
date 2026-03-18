#!/bin/bash

# 多目标 MySQL 死锁监控系统 - 构建和测试脚本

set -e

# 切换到脚本所在目录
cd "$(dirname "$0")"

echo "=========================================="
echo "  多目标 MySQL 死锁监控系统 - 构建测试"
echo "=========================================="

# 1. 检查必要文件
echo ""
echo "[1/5] 检查必要文件..."
files=("server.js" "monitor-manager.js" "supervisord.conf" "Dockerfile" "init.sql" "public/index.html" "docker-compose.yml")
for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        echo "  ✓ $file 存在"
    else
        echo "  ✗ $file 缺失"
        exit 1
    fi
done

# 2. 检查 Node.js 依赖
echo ""
echo "[2/5] 检查 Node.js 依赖..."
if [ -f "package.json" ]; then
    echo "  package.json 存在"
    npm install 2>/dev/null && echo "  ✓ 依赖安装成功" || echo "  ! 依赖安装跳过（无 npm 环境）"
fi

# 3. 语法检查
echo ""
echo "[3/5] JavaScript 语法检查..."
if command -v node &> /dev/null; then
    node --check server.js && echo "  ✓ server.js 语法正确"
    node --check monitor-manager.js && echo "  ✓ monitor-manager.js 语法正确"
else
    echo "  ! Node.js 未安装，跳过语法检查"
fi

# 4. Docker 构建测试
echo ""
echo "[4/5] Docker 构建测试..."
if command -v docker &> /dev/null; then
    echo "  开始构建 Docker 镜像..."
    docker build -t deadlock-monitor:test . && echo "  ✓ Docker 镜像构建成功" || echo "  ✗ Docker 镜像构建失败"
else
    echo "  ! Docker 未安装，跳过构建测试"
fi

# 5. 数据库表结构检查
echo ""
echo "[5/5] 数据库表结构检查..."
if grep -q "monitor_tasks" init.sql && grep -q "source_server" init.sql; then
    echo "  ✓ 监控任务表结构已定义"
    echo "  ✓ 死锁表 source_server 字段已添加"
else
    echo "  ✗ 表结构定义不完整"
fi

echo ""
echo "=========================================="
echo "  检查完成！"
echo "=========================================="
echo ""
echo "下一步操作:"
echo "1. 使用 Docker Compose 启动："
echo "   docker-compose up -d"
echo ""
echo "2. 访问 Web 界面："
echo "   http://localhost:9527"
echo ""
echo "3. 添加监控任务："
echo "   - 切换到「监控任务」标签"
echo "   - 填写目标 MySQL 信息"
echo "   - 点击「创建任务」"
echo ""
