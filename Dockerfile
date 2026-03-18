FROM debian:bookworm-slim

# 安装依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    perl \
    libdbd-mysql-perl \
    percona-toolkit \
    supervisor \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/supervisor /var/log/nodejs /var/log/monitor-manager /var/log/namespace-backfill

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

# 复制 supervisor 配置
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 9527

ENV PORT=9527
ENV DB_HOST=mysql
ENV DB_PORT=3306
ENV DB_USER=root
ENV DB_PASSWORD=root
ENV DB_NAME=deadlock_monitor

# 启动 supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
