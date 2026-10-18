# syntax=docker/dockerfile:1
# Jana Address — автономный образ.
# Справочник КАТО и собранный веб-интерфейс запекаются внутрь образа,
# на этапе прогона сеть не нужна.

# --- Этап сборки справочника -------------------------------------------------
# REBUILD_KATO=1 — пересобрать справочник из исходного XLSX (офлайн, из
# data/kato/source/kato.xlsx), либо скачать с stat.gov.kz, если кэша нет.
FROM node:22-alpine AS kato-builder
WORKDIR /app
COPY scripts ./scripts
COPY src/lexicon.js ./src/lexicon.js
COPY data/kato ./data/kato
ARG REBUILD_KATO=0
RUN if [ "$REBUILD_KATO" = "1" ]; then \
      if [ -f data/kato/source/kato.xlsx ]; then \
        node scripts/build_kato.js --local data/kato/source/kato.xlsx; \
      else \
        node scripts/build_kato.js; \
      fi; \
    else \
      echo "KATO: используется предсобранный reference.json"; \
    fi

# --- Этап сборки веб-интерфейса (Vue + Vite) ---------------------------------
FROM node:22-alpine AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

# --- Рабочий образ -----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY package.json ./
COPY src ./src
COPY server ./server
# Собранный интерфейс отдаётся сервером из web/dist.
COPY --from=web-builder /web/dist ./web/dist
# Примеры данных (без исходного XLSX КАТО).
COPY data/sample_input.json data/sample_output.json data/examples.txt ./data/
# Готовый уличный справочник OSM (собирается npm run fetch:osm && build:gazetteer).
COPY data/gazetteer.json ./data/gazetteer.json
# Готовый справочник КАТО.
COPY --from=kato-builder /app/data/kato/reference.json ./data/kato/reference.json

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server/app.js"]
