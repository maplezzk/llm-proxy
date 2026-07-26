#!/usr/bin/env bash
# init-db.sh：幂等创建专用数据库 llmproxy_dev（默认）。
#
# 前置：宿主有 docker，且本机存在名为 `postgres` 的 postgres:16-alpine 容器，
#       该容器加入了自定义 bridge network `shared-net`，暴露 5432。
#
# 用法：
#   bash scripts/init-db.sh                       # 默认库名 llmproxy_dev
#   POSTGRES_DB=mydb bash scripts/init-db.sh     # 自定义库名
#   POSTGRES_USER=dev bash scripts/init-db.sh     # 自定义用户
#
# 幂等：若库已存在则跳过 CREATE DATABASE；任何错误非零退出。

set -euo pipefail

CONTAINER_NAME="${POSTGRES_CONTAINER:-postgres}"
DB_NAME="${POSTGRES_DB:-llmproxy_dev}"
DB_USER="${POSTGRES_USER:-dev}"

echo "init-db: container=${CONTAINER_NAME} user=${DB_USER} db=${DB_NAME}"

EXISTS=$(docker exec -u postgres "${CONTAINER_NAME}" \
  psql -U "${DB_USER}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}';" 2>/dev/null || true)

if [[ "${EXISTS}" == "1" ]]; then
  echo "init-db: database '${DB_NAME}' already exists; nothing to do"
  exit 0
fi

echo "init-db: creating database '${DB_NAME}'"
docker exec -u postgres "${CONTAINER_NAME}" \
  createdb -U "${DB_USER}" "${DB_NAME}"

echo "init-db: done. connection string example:"
echo "  postgres://${DB_USER}:<password>@127.0.0.1:5432/${DB_NAME}"
