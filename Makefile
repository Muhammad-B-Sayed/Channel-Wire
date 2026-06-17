CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Wpedantic -Werror -O2 -g
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L -Icore/include
LDFLAGS ?=
SANITIZE_FLAGS := -fsanitize=address,undefined -fno-omit-frame-pointer
SANITIZE ?= 0

ifeq ($(SANITIZE),1)
BUILD_MODE := sanitize
CFLAGS += $(SANITIZE_FLAGS)
else
BUILD_MODE := release
endif

BUILD_DIR := build
OBJ_DIR := $(BUILD_DIR)/obj/$(BUILD_MODE)
CORE_BIN := $(BUILD_DIR)/channelwire-server
CORE_SRCS := core/src/server.c core/src/protocol.c
CORE_OBJS := $(CORE_SRCS:%.c=$(OBJ_DIR)/%.o)

.PHONY: all clean test test-load benchmark test-lifecycle test-backpressure test-malformed test-gateway test-migrations test-compose migrate-db frontend-build sanitize docker-build docker-up docker-down FORCE

all: $(CORE_BIN)

$(CORE_BIN): $(CORE_OBJS) FORCE
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(CORE_OBJS)

$(OBJ_DIR)/%.o: %.c
	@mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c -o $@ $<

FORCE:

sanitize:
	$(MAKE) SANITIZE=1 all

test: all
	python3 tests/integration_test.py --server ./$(CORE_BIN)

test-load: all
	python3 tests/load_test.py --server ./$(CORE_BIN)

benchmark: all
	python3 tests/load_test.py --server ./$(CORE_BIN) --clients 64 --report docs/benchmarks/latest-load.json

test-lifecycle: all
	python3 tests/lifecycle_test.py --server ./$(CORE_BIN)

test-backpressure: all
	python3 tests/backpressure_test.py --server ./$(CORE_BIN)

test-malformed: all
	python3 tests/malformed_test.py --server ./$(CORE_BIN)

test-gateway: all
	python3 tests/gateway_smoke_test.py --server ./$(CORE_BIN)

test-migrations:
	python3 tests/migration_test.py

test-compose:
	python3 tests/compose_smoke_test.py

migrate-db:
	python3 -m alembic -c gateway/alembic.ini upgrade head

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
