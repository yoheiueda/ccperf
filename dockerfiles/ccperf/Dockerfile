FROM node:10
COPY ccperf.js /
COPY package.json /
RUN apt-get update -y && apt-get install -y build-essential
RUN npm install --install-from-source grpc@1.14.2
RUN npm install --install-from-source
ENTRYPOINT ["node", "/ccperf.js"]
