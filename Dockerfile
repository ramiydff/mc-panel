FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY relay.js setup.js ./
COPY public ./public

# Render يمرّر PORT تلقائيًا؛ relay.js يقرأه من env تلقائيًا
EXPOSE 8080

CMD ["node", "relay.js"]
