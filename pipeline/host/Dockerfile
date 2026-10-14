FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libstdc++6 libgomp1 libasound2 libsndfile1 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY host.c *.h /src/
RUN gcc -O2 -o /usr/local/bin/schost /src/host.c -ldl -lpthread -lm
