FROM node:18.16

WORKDIR /home/server

COPY . .

ENV CERAMIC_ENABLE_EXPERIMENTAL_COMPOSE_DB=true

#RUN npm install

EXPOSE 7007

RUN npm run generate
CMD ["npm", "run", "dev"]
