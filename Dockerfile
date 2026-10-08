# syntax=docker/dockerfile:1
#
# Production image: Quartz builds the site in the builder stage and a static
# nginx serves it. Build with
#   docker build --build-arg APP_DOMAIN=kb.example.org .
# APP_DOMAIN becomes Quartz's baseUrl (sitemap, RSS, canonical links); the
# committed quartz.config.yaml keeps the GitHub Pages value.

# The full (non-slim) node image: the quartz CLI shells out to git at import
# time and crashes without the binary, and git history gives page dates.
FROM node:22-bookworm AS builder

ARG APP_DOMAIN
# Validated before it reaches sed: the pattern admits no '|', '&' or '/'.
RUN if ! printf '%s' "$APP_DOMAIN" | grep -Eqx '[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+'; then \
      echo "APP_DOMAIN must be a lowercase hostname such as kb.example.org (got '${APP_DOMAIN}')" >&2; \
      exit 1; \
    fi

# Set before the COPY: in a git worktree checkout the copied .git is a file
# pointing outside the context, and any git command run beside it fails.
# Quartz's own git lookups tolerate that and fall back to file dates.
RUN git config --global --add safe.directory /src

WORKDIR /src
# .git is part of the context (see .dockerignore) so Quartz can read page
# dates from history. It stays in this stage and never reaches the final image.
COPY . .

RUN npm ci --no-audit --no-fund \
 && npx quartz plugin install --from-config

# The grep fails the build if the sed matched nothing.
RUN sed -i -E "s|^  baseUrl: .*$|  baseUrl: ${APP_DOMAIN}|" quartz.config.yaml \
 && grep -qxF "  baseUrl: ${APP_DOMAIN}" quartz.config.yaml \
 && npx quartz build

FROM nginxinc/nginx-unprivileged:1.31-alpine

COPY --from=builder /src/public /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Numeric, so the kubelet can verify runAsNonRoot; the Deployment's
# runAsUser must match.
USER 101
EXPOSE 8080
