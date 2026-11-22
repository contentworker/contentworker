FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 libreoffice-impress poppler-utils tesseract-ocr fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/parser
COPY *.py ./
USER nobody
ENTRYPOINT ["python3", "parser.py"]
