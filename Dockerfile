# THOT API + dashboard for a dstack CVM. The verifier binary comes from the named
# `verifier` build context (scripts/build-thot-image.sh); nothing is compiled here.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages cryptography certifi \
    && rm -rf /var/lib/apt/lists/* && npm i -g pnpm@10.34.5
COPY --from=verifier /dcap-qvl /usr/local/bin/dcap-qvl
ARG THOT_SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$THOT_SOURCE_REVISION
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile --prod
COPY contracts/package.json contracts/pnpm-lock.yaml ./contracts/
RUN pnpm --dir contracts install --frozen-lockfile
COPY contracts/src ./contracts/src
COPY contracts/scripts/thot-local-fixture.mjs ./contracts/scripts/thot-local-fixture.mjs
COPY apps ./apps
COPY packages ./packages
COPY migrations ./migrations
COPY scripts ./scripts
RUN node scripts/build-privy-auth.mjs
COPY trace-vault/appraisal_transport.py \
     trace-vault/attest.py \
     trace-vault/attestation_verify.py \
     trace-vault/browser_capture.py \
     trace-vault/credential_robinhood.py \
     trace-vault/link_capture.py \
     trace-vault/link_ticket.py \
     trace-vault/reveal.py \
     trace-vault/robinhood_appraiser.py \
     trace-vault/robinhood_link.py \
     trace-vault/witness.py ./trace-vault/
COPY trace-vault/deploy/robinhood-measurements.json ./trace-vault/deploy/
COPY deploy/thot-config.cvm.json deploy/thot-config.trade-candidate.example.json deploy/tee-recorder-policy.json ./deploy/
RUN cd trace-vault && python3 -c "import robinhood_link" && /usr/local/bin/dcap-qvl --help >/dev/null && mkdir -m 0700 /data
ENV THOT_BIND=0.0.0.0 THOT_DATA_DIR=/data THOT_ROBINHOOD_CONFIG_FILE=/app/deploy/thot-config.cvm.json PYTHONDONTWRITEBYTECODE=1
EXPOSE 4318
CMD ["sh","-c","node scripts/cvm-prestart.ts && exec node apps/api/server.ts"]
