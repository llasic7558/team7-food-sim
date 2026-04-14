FROM python:3.11-alpine

WORKDIR /app

# system deps for psycopg2
RUN apk add --no-cache gcc musl-dev libffi-dev postgresql-dev curl

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["gunicorn", "-b", "0.0.0.0:8000", "app:app"]
