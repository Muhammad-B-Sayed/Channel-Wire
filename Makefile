CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Wpedantic -Werror -O2 -g
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L -Icore/include
LDFLAGS ?=
SANITIZE_FLAGS := -fsanitize=address,undefined -fno-omit-frame-pointer

BUILD_DIR := build
CORE_BIN := $(BUILD_DIR)/channelwire-server
CORE_SRCS := core/src/server.c core/src/protocol.c
CORE_OBJS := $(CORE_SRCS:%.c=$(BUILD_DIR)/%.o)

.PHONY: all clean test test-load test-backpressure test-malformed test-gateway test-compose frontend-build sanitize docker-build docker-up docker-down

all: $(CORE_BIN)

$(CORE_BIN): $(CORE_OBJS)
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^

$(BUILD_DIR)/%.o: %.c
	@mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c -o $@ $<

sanitize: CFLAGS += $(SANITIZE_FLAGS)
sanitize: clean all

test: all
	python3 tests/integration_test.py --server ./$(CORE_BIN)

test-load: all
	python3 tests/load_test.py --server ./$(CORE_BIN)

test-backpressure: all
	python3 tests/backpressure_test.py --server ./$(CORE_BIN)

test-malformed: all
	python3 tests/malformed_test.py --server ./$(CORE_BIN)

test-gateway: all
	python3 tests/gateway_smoke_test.py --server ./$(CORE_BIN)

test-compose:
	python3 tests/compose_smoke_test.py

frontend-build:
	npm --prefix frontend install
	npm --prefix frontend run build

docker-build:
	docker compose build

docker-up:
	docker compose up --build

docker-down:
	docker compose down

clean:
	rm -rf $(BUILD_DIR)

-include $(CORE_OBJS:.o=.d)
