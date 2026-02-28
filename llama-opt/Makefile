CC = gcc
CFLAGS = -O3 -march=armv8.2-a+dotprod -mtune=neoverse-n1 -Wall -Wextra
LDFLAGS = -lm

.PHONY: all clean run

all: benchmark

benchmark: benchmark.c q4_0_optimized.c
	$(CC) $(CFLAGS) -o $@ benchmark.c $(LDFLAGS)

run: benchmark
	./benchmark

# Disassembly for inspection
disasm: benchmark
	objdump -d benchmark | grep -A 200 'vec_dot_q4_0_q8_0_optimized>' | head -250

clean:
	rm -f benchmark
