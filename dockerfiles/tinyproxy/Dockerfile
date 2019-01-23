FROM alpine
RUN apk add --no-cache tinyproxy
RUN sed -i -e 's/Allow 127\.0\.0\.1/#\0/' /etc/tinyproxy/tinyproxy.conf
EXPOSE 8888
ENTRYPOINT ["/usr/sbin/tinyproxy"]
CMD ["-d"]
