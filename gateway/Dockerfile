FROM python:3.12-slim

WORKDIR /app
COPY gateway/requirements.txt ./gateway/requirements.txt
RUN pip install --no-cache-dir -r gateway/requirements.txt
COPY tools ./tools
COPY gateway ./gateway
ENV PYTHONPATH=/app
EXPOSE 8000
CMD ["uvicorn", "gateway.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
