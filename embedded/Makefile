CC      ?= cc
CFLAGS  ?= -std=c11 -O2 -g -Wall -Wextra -Wpedantic -pthread
LDFLAGS ?=
LDLIBS  ?=

TARGET      := pc_sem
ASAN_TARGET := pc_sem_asan
TSAN_TARGET := pc_sem_tsan
SRC         := src/pc_sem.c

.PHONY: all clean test sanitize tsan

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) $(SRC) -o $@ $(LDFLAGS) $(LDLIBS)

$(ASAN_TARGET): $(SRC)
	$(CC) $(CFLAGS) -fno-omit-frame-pointer \
		-fsanitize=address,undefined $(SRC) -o $@ $(LDFLAGS) $(LDLIBS)

$(TSAN_TARGET): $(SRC)
	$(CC) $(CFLAGS) -fno-omit-frame-pointer \
		-fsanitize=thread $(SRC) -o $@ $(LDFLAGS) $(LDLIBS)

sanitize: $(ASAN_TARGET)
tsan: $(TSAN_TARGET)

test: $(TARGET)
	./tests/run_tests.sh

clean:
	rm -f $(TARGET) $(ASAN_TARGET) $(TSAN_TARGET)
