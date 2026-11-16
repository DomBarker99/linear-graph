# linear-graph: one TypeScript file and one page, run by Node directly (type stripping).
# There is no build step and there are no dependencies.
#
# GitHub Actions builds this on every push to main (.github/workflows/image.yaml).
#
# Try it by hand, with the made-up issues in sample.json:
#   docker build -t linear-graph:scratch .
#   docker run --rm -p 127.0.0.1:8080:8080 -v "$PWD/sample.json:/sample.json:ro" \
#     -e GRAPH_FIXTURE=/sample.json linear-graph:scratch
#   open http://127.0.0.1:8080

FROM node:26-alpine
# A fixed non-root user. The server writes nothing to disk.
RUN addgroup -S -g 65532 graph && \
    adduser -S -D -u 65532 -G graph graph
COPY server.ts /app/server.ts
COPY public /app/public
USER 65532:65532
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.ts"]
