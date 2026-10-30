# Docker Hub is unreachable from the Shenzhen build host; this public mirror is
# the same one the existing gateway container uses.
FROM docker.m.daocloud.io/library/node:22-alpine

WORKDIR /app
COPY package.json server.mjs pipeline.mjs agents.mjs store.mjs ./

COPY dsh/package.json dsh/package-lock.json ./dsh/
COPY dsh/plugins/package.json ./dsh/plugins/package.json
RUN cd dsh && npm ci --omit=dev

COPY dsh ./dsh
RUN mkdir -p /app/dsh/.runtime-home /app/dsh/workspace /data

ENV NODE_ENV=production
ENV DSH_HOME_DIR=/app/dsh/.runtime-home
EXPOSE 8787
CMD ["node", "--experimental-sqlite", "server.mjs"]
