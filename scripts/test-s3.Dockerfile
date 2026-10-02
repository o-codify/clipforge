# Disposable CI fixture. Build the audited upstream revision rather than
# depending on a removable public MinIO binary image tag.
FROM golang:1.25-alpine AS build
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth=1 --branch RELEASE.2025-09-07T16-13-09Z https://github.com/minio/minio.git . \
 && test "$(git rev-parse HEAD)" = "07c3a429bfed433e49018cb0f78a52145d4bedeb"
RUN CGO_ENABLED=0 go build -trimpath -o /minio .
FROM alpine:3.22
COPY --from=build /minio /usr/local/bin/minio
RUN mkdir /data && chown 1000:1000 /data
USER 1000:1000
ENV HOME=/tmp
ENTRYPOINT ["minio"]
