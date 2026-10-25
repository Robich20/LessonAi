FROM python:3.12-slim

# Set LOCAL_WHISPER=true to bundle faster-whisper for fully local transcription (bigger image).
ARG LOCAL_WHISPER=false

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$LOCAL_WHISPER" = "true" ]; then pip install --no-cache-dir faster-whisper==1.1.1; fi

COPY app/ .
ENV DATA_DIR=/data PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
