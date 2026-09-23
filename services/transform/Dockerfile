# Runs the Dataform SQL models (dataform/) against BigQuery as a Cloud Run
# job, so no Dataform Git connection or GitHub token is needed.
# Build from the repository root:  docker build -f services/transform/Dockerfile .
FROM node:22-slim
WORKDIR /app
RUN npm install -g @dataform/cli@3.0.70
COPY dataform/ ./
# Install @dataform/core into the image instead of letting the CLI download it
# on every run (it does that when dataformCoreVersion is set).
RUN CORE=$(sed -n 's/^dataformCoreVersion: *//p' workflow_settings.yaml) \
  && sed -i '/^dataformCoreVersion:/d' workflow_settings.yaml \
  && printf '{"private":true,"dependencies":{"@dataform/core":"%s"}}\n' "$CORE" > package.json \
  && npm install --ignore-scripts --omit=dev \
  && dataform compile .
COPY services/transform/run.sh /usr/local/bin/run-transform
RUN chmod +x /usr/local/bin/run-transform && chown -R node /app
USER node
CMD ["run-transform"]
