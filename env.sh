
export GOPATH="$PWD/go"

. .env

if ! [[ ":$PATH:" =~ ":$PWD/bin:" ]]; then
  export PATH="$PWD/bin:$PATH"
fi

if ! [[ ":$PATH:" =~ ":$PWD/bin/FlameGraph:" ]]; then
  export PATH="$PWD/bin/FlameGraph:$PATH"
fi

if ! [[ ":$PATH:" =~ ":$GOPATH/bin:" ]]; then
  export PATH="$GOPATH/bin:$PATH"
fi
