# The stealth tier (opportunity types plan step 6c-2, D15): Scrapling's StealthyFetcher in its official
# image (arm64 and amd64), the setup sources.md measured against Kaggle on the VM. Build context is stealth/:
#   docker build -f deploy/stealth.Dockerfile -t "$APP_IMAGE-stealth" stealth
# deploy.sh tags it after the app image, so a rollback of APP_IMAGE moves it too. The base is pinned by
# digest: a Scrapling upgrade is a deliberate change, measured again against the sources that use the tier.
FROM pyd4vinci/scrapling:0.5.1@sha256:b4e92cde7e7e2d9f5940e90ee796cbf7340843a6de7213c0c409fe3d2aadfd87
# The base runs as root with its browsers in root's cache. The service loads untrusted pages, so it runs
# as its own user and reads the browsers where they are (no copy: they are most of the image). The tests
# fail the build, not the first render, if a later base moves the interpreter or the browsers.
RUN test -x /app/.venv/bin/python && test -d /root/.cache/ms-playwright \
    && /app/.venv/bin/python -c "import scrapling.fetchers" \
    && useradd --create-home --uid 10001 stealth \
    && chmod a+rx /root /root/.cache
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
WORKDIR /srv/stealth
COPY server.py ./
USER stealth
EXPOSE 3100
# The base's entrypoint is its command line tool (`uv run scrapling`).
ENTRYPOINT []
CMD ["/app/.venv/bin/python", "server.py"]
