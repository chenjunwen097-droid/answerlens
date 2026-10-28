# Docker Hub is unreachable from the Shenzhen build host; this public mirror is
# the same one the existing gateway container uses.
FROM docker.m.daocloud.io/library/node:22-alpine

WORKDIR /app
COPY package.json server.mjs ./

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "--experimental-sqlite", "server.mjs"]
