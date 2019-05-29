ARG BASE_VERSION="0.4.15"

FROM ubuntu AS go
ARG GO_VERSION="1.12.5"
ADD go-wakup-profile-go1.11.patch /
WORKDIR /usr/local
RUN apt-get update -y && apt-get install -y build-essential golang git
RUN git clone -b go${GO_VERSION} https://go.googlesource.com/go
RUN cd go && patch -p1 < /go-wakup-profile-go1.11.patch
RUN cd go/src && env GOROOT_BOOTSTRAP=$(go env GOROOT) bash ./make.bash
RUN rm -fr /usr/local/go/pkg/bootstrap /usr/local/go/pkg/obj

FROM hyperledger/fabric-baseimage:${BASE_VERSION}
RUN rm -rf /opt/go
COPY --from=go /usr/local/go /opt/go
