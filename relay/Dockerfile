# FilmFlix Relay — no dependencies beyond Node itself, so the image stays tiny.
FROM node:20-alpine

WORKDIR /app

COPY relay.mjs channels.json ./

# Inside the container we must bind 0.0.0.0 so Docker's port mapping works.
# Public exposure is controlled by the host (compose ports / firewall / Nginx).
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8077

RUN addgroup -S relay && adduser -S relay -G relay \
    && chown -R relay:relay /app
USER relay

EXPOSE 8077
CMD ["node", "relay.mjs"]