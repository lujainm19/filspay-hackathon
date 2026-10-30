# Multi-stage build of apps/settlement. The build cache stays in the builder
# stage, so it can't fill the 2 GB disk on the box (AM's July note).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/settlement /settlement
USER nonroot
ENTRYPOINT ["/settlement"]
