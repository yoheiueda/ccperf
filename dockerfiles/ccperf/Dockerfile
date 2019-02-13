FROM node:10-alpine as modules
COPY package.json /
RUN apk add --no-cache alpine-sdk python
RUN npm install --install-from-source grpc@1.14.2
RUN npm install --install-from-source

FROM node:10-alpine
COPY ccperf.js /
COPY --from=modules /package.json /
COPY --from=modules /package-lock.json /
COPY --from=modules /node_modules /node_modules
ENTRYPOINT ["node", "/ccperf.js"]
