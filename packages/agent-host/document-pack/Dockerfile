FROM python:3.13.7-slim@sha256:5f55cdf0c5d9dc1a415637a5ccc4a9e18663ad203673173b8cda8f8dcacef689
ARG OFFICE=0
ARG OCR=0
RUN apt-get update && apt-get install -y --no-install-recommends fonts-wqy-zenhei && \
    if [ "$OFFICE" = 1 ]; then apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc fonts-noto-cjk; fi && \
    if [ "$OCR" = 1 ]; then apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-chi-sim; fi && \
    rm -rf /var/lib/apt/lists/*
COPY requirements.txt /opt/turnsu/requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/turnsu/requirements.txt
COPY worker.py /opt/turnsu/worker.py
ENV PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
USER 65534:65534
ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=5s", "120s", "python", "-I", "/opt/turnsu/worker.py"]
