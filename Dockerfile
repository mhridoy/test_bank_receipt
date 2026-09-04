FROM python:3.12-slim

# opencv (pulled in by rapidocr) needs these two system libs
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Warm the OCR models into the image layer so the first request is not slow.
RUN python -c "from rapidocr_onnxruntime import RapidOCR; RapidOCR()"

ENV CLOUD_MODE=1 PORT=10000
EXPOSE 10000

# One worker: the scan jobs and the OCR session live in process memory.
CMD gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 300
