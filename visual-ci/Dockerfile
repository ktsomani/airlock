FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /runner
RUN npm install --no-audit --no-fund --ignore-scripts --no-package-lock playwright@1.64.1
COPY capture.mjs .
USER pwuser
ENTRYPOINT ["node", "/runner/capture.mjs"]
