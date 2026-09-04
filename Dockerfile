FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./
COPY templates ./templates
COPY static ./static

ENV PORT=10000
EXPOSE 10000

# The server only serves the page; all the work happens in the visitor's browser.
CMD gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --threads 4
