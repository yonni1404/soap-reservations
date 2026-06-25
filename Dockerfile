# Node 24 : intègre node:sqlite (utilisé par l'appli) sans dépendance native à compiler
FROM node:24-alpine

WORKDIR /app

# Installe les dépendances (toutes pures JS — pas de build natif requis)
COPY package*.json ./
RUN npm install --omit=dev

# Code de l'application
COPY . .

# La base SQLite vit dans /app/data (monté en volume → persistant)
ENV DB_PATH=/app/data/soap.db

EXPOSE 3010

CMD ["node", "src/index.js"]
