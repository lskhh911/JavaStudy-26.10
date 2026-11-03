#!/usr/bin/env bash
# Run the producer-consumer test matrix on Linux.
set -u

cd "$(dirname "$0")/.."

BIN=./pc_sem
CASE_TIMEOUT=30s
OUT=""
RC=0
TEST_OK=1
PASS=0
FAIL=0

pass_case() {
    PASS=$((PASS + 1))
    printf '[PASS] %s\n' "$1"
}

fail_case() {
    FAIL=$((FAIL + 1))
    printf '[FAIL] %s\n' "$1"
}

note_fail() {
    TEST_OK=0
    printf '       %s\n' "$1"
}

run_case() {
    OUT=$(timeout "$CASE_TIMEOUT" "$BIN" "$@" 2>&1)
    RC=$?
}

run_asan_case() {
    OUT=$(ASAN_OPTIONS=detect_leaks=1:abort_on_error=1 \
          UBSAN_OPTIONS=halt_on_error=1 \
          timeout "$CASE_TIMEOUT" "$BIN" "$@" 2>&1)
    RC=$?
}

run_tsan_case() {
    OUT=$(TSAN_OPTIONS=halt_on_error=1 \
          timeout "$CASE_TIMEOUT" "$BIN" "$@" 2>&1)
    RC=$?
}

field() {
    local line
    line=$(printf '%s\n' "$OUT" | grep '^RESULT ' | tail -n 1 || true)
    printf '%s\n' "$line" | tr ' ' '\n' | sed -n "s/^$1=//p" | tail -n 1
}

assert_exit() {
    if [ "$RC" -ne "$1" ]; then
        note_fail "exit=$RC, expected $1"
    fi
}

assert_pass() {
    if [ "$RC" -ne 0 ]; then
        note_fail "exit=$RC, expected 0"
    fi
    if ! printf '%s\n' "$OUT" | grep -q '^RESULT '; then
        note_fail "missing RESULT line"
        return
    fi
    if [ "$(field status)" != "PASS" ]; then
        note_fail "status=$(field status), expected PASS"
    fi
}

assert_field_eq() {
    local actual
    actual=$(field "$1")
    if [ "$actual" != "$2" ]; then
        note_fail "$1=$actual, expected $2"
    fi
}

assert_field_ge() {
    local actual
    actual=$(field "$1")
    actual=${actual%s}
    if [ -z "$actual" ] || ! awk -v a="$actual" -v b="$2" 'BEGIN { exit !(a >= b) }'; then
        note_fail "$1=$actual, expected >= $2"
    fi
}

assert_field_le() {
    local actual
    actual=$(field "$1")
    actual=${actual%s}
    if [ -z "$actual" ] || ! awk -v a="$actual" -v b="$2" 'BEGIN { exit !(a <= b) }'; then
        note_fail "$1=$actual, expected <= $2"
    fi
}

finish_case() {
    if [ "$TEST_OK" -eq 1 ]; then
        pass_case "$1"
    else
        fail_case "$1"
    fi
}

begin_case() {
    TEST_OK=1
    OUT=""
    RC=0
}

check_invalid() {
    local name=$1
    shift
    begin_case
    run_case "$@"
    if [ "$RC" -eq 2 ]; then
        pass_case "$name"
    else
        note_fail "exit=$RC, expected 2"
        fail_case "$name"
    fi
}

printf '== T1 smoke: P1 C1 N1 K5 ==\n'
begin_case
run_case --producers 1 --consumers 1 --buffer 1 --items 5 \
    --prod-delay-ms 0 --cons-delay-ms 0 --log-level 2
assert_pass
assert_field_eq produced 5
assert_field_eq consumed 5
assert_field_eq unique 5
assert_field_eq missing 0
assert_field_eq duplicate 0
assert_field_eq max_count 1
finish_case "T1 single producer/consumer"

printf '== T2 basic concurrency: P3 C3 N5 K20 ==\n'
begin_case
run_case --producers 3 --consumers 3 --buffer 5 --items 20 \
    --prod-delay-ms 5 --cons-delay-ms 10 --log-level 1
assert_pass
assert_field_eq produced 60
assert_field_eq consumed 60
assert_field_eq unique 60
assert_field_eq missing 0
assert_field_eq duplicate 0
assert_field_le max_count 5
finish_case "T2 basic concurrency"

printf '== T3 full-buffer blocking: N1, slow consumer ==\n'
begin_case
run_case --producers 1 --consumers 1 --buffer 1 --items 5 \
    --prod-delay-ms 0 --cons-delay-ms 100 --log-level 2
assert_pass
assert_field_eq consumed 5
assert_field_eq max_count 1
assert_field_ge elapsed 0.4
finish_case "T3 full-buffer blocking"

printf '== T4 empty-buffer blocking: N1, slow producer ==\n'
begin_case
run_case --producers 1 --consumers 1 --buffer 1 --items 5 \
    --prod-delay-ms 100 --cons-delay-ms 0 --log-level 2
assert_pass
assert_field_eq consumed 5
assert_field_ge elapsed 0.4
finish_case "T4 empty-buffer blocking"

printf '== T5 stress: P8 C8 N64 K50000 ==\n'
begin_case
run_case --producers 8 --consumers 8 --buffer 64 --items 50000 \
    --prod-delay-ms 0 --cons-delay-ms 0 --log-level 0
assert_pass
assert_field_eq produced 400000
assert_field_eq consumed 400000
assert_field_eq unique 400000
assert_field_eq missing 0
assert_field_eq duplicate 0
assert_field_le max_count 64
assert_field_le elapsed 15
finish_case "T5 stress 400k items"

printf '== T6 large buffer: P4 C4 N1024 K10000 ==\n'
begin_case
run_case --producers 4 --consumers 4 --buffer 1024 --items 10000 \
    --prod-delay-ms 0 --cons-delay-ms 0 --log-level 0
assert_pass
assert_field_eq produced 40000
assert_field_eq consumed 40000
assert_field_le max_count 1024
finish_case "T6 large buffer"

printf '== T7 invalid arguments ==\n'
check_invalid "T7a producers=0" --producers 0
check_invalid "T7b buffer=0" --buffer 0
check_invalid "T7c items=0" --items 0
check_invalid "T7d unknown option" --bogus

printf '== T10 repeatability: T2 x20 ==\n'
repeat_ok=1
i=0
while [ "$i" -lt 20 ]; do
    begin_case
    run_case --producers 3 --consumers 3 --buffer 5 --items 20 \
        --prod-delay-ms 5 --cons-delay-ms 10 --log-level 0
    if [ "$RC" -ne 0 ] || [ "$(field status)" != "PASS" ]; then
        repeat_ok=0
        note_fail "iteration $((i + 1)): exit=$RC status=$(field status)"
        break
    fi
    i=$((i + 1))
done
if [ "$repeat_ok" -eq 1 ]; then
    pass_case "T10 repeatability 20/20"
else
    fail_case "T10 repeatability"
fi

printf '== T8 AddressSanitizer + UBSan ==\n'
if make clean >/dev/null 2>&1 && make sanitize >/dev/null 2>&1; then
    BIN=./pc_sem_asan
    CASE_TIMEOUT=30s

    begin_case
    run_asan_case --producers 1 --consumers 1 --buffer 1 --items 5 \
        --prod-delay-ms 0 --cons-delay-ms 0 --log-level 2
    assert_pass
    finish_case "T8a ASan/UBSan smoke"

    begin_case
    run_asan_case --producers 3 --consumers 3 --buffer 5 --items 100 \
        --prod-delay-ms 0 --cons-delay-ms 0 --log-level 0
    assert_pass
    assert_field_eq consumed 300
    finish_case "T8b ASan/UBSan concurrency"
else
    printf '       sanitizer build failed\n'
    fail_case "T8 AddressSanitizer + UBSan"
fi

printf '== T9 ThreadSanitizer ==\n'
if make clean >/dev/null 2>&1 && make tsan >/dev/null 2>&1; then
    BIN=./pc_sem_tsan
    CASE_TIMEOUT=120s

    begin_case
    run_tsan_case --producers 3 --consumers 3 --buffer 5 --items 200 \
        --prod-delay-ms 0 --cons-delay-ms 0 --log-level 0
    assert_pass
    assert_field_eq consumed 600
    finish_case "T9a TSan basic"

    begin_case
    run_tsan_case --producers 8 --consumers 8 --buffer 64 --items 5000 \
        --prod-delay-ms 0 --cons-delay-ms 0 --log-level 0
    assert_pass
    assert_field_eq consumed 40000
    finish_case "T9b TSan stress"
else
    printf '       TSan build failed\n'
    fail_case "T9 ThreadSanitizer"
fi

make clean >/dev/null 2>&1
make >/dev/null 2>&1

printf '\nTEST_SUMMARY passed=%d failed=%d\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
