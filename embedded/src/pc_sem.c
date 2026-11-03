/*
 * 实验一：信号量通信实验
 * 多线程生产者–消费者模型（有界环形缓冲区）
 *
 * 同步原语：
 *   empty  : 计数信号量，表示空槽许可，初值 N
 *   full   : 计数信号量，表示已发布数据许可，初值 0
 *   mutex  : 二值信号量，保护 slots / in / out / count
 *
 * 终止协议：
 *   1) 全部生产者完成 K 次生产后 join；
 *   2) main 向缓冲区注入 C 个 ITEM_STOP；
 *   3) 每个消费者取到 STOP 后退出；
 *   4) join 全部消费者，输出结果并校验。
 */

#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <limits.h>
#include <pthread.h>
#include <semaphore.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_PRODUCERS 64
#define MAX_CONSUMERS 64
#define MAX_BUFFER 4096
#define MAX_ITEMS 1000000
#define MAX_TOTAL 20000000

typedef enum {
    ITEM_DATA = 0,
    ITEM_STOP = 1
} item_kind_t;

typedef struct {
    item_kind_t kind;
    int producer_id; /* 1..P for data, 0 for main's STOP */
    int seq;         /* 1..K for data, 0 for STOP */
} item_t;

typedef struct {
    item_t *slots;
    size_t capacity;
    size_t in;
    size_t out;
    size_t count;
    size_t max_count;
    sem_t empty;
    sem_t full;
    sem_t mutex;
    int empty_ok;
    int full_ok;
    int mutex_ok;
} buffer_t;

typedef struct {
    int producers;
    int consumers;
    size_t capacity;
    size_t items_per_producer;
    int prod_delay_ms;
    int cons_delay_ms;
    int log_level;
    unsigned int seed;
    int verify;
} config_t;

typedef struct {
    pthread_mutex_t lock;
    int level;
    struct timespec start;
} logger_t;

typedef struct {
    pthread_mutex_t lock;
    pthread_cond_t cond;
    int open;
    int abort;
} gate_t;

typedef struct {
    pthread_mutex_t lock;
    unsigned char *bits;
    size_t nbits;
    size_t producers;
    size_t items_per_producer;
    size_t unique;
    size_t duplicate;
    size_t invalid;
    int enabled;
} verifier_t;

typedef struct {
    int id;
    int is_producer;
    const config_t *cfg;
    buffer_t *buf;
    logger_t *log;
    verifier_t *verify;
    gate_t *gate;
    pthread_t tid;
    int created;
    size_t produced;
    size_t consumed;
    unsigned int rng;
} worker_t;

static void die(const char *what)
{
    int saved = errno;
    fprintf(stderr, "FATAL: %s: %s\n", what, saved ? strerror(saved) : "error");
    exit(EXIT_FAILURE);
}

static void *xcalloc(size_t n, size_t size)
{
    void *p = calloc(n, size);
    if (p == NULL) {
        die("calloc");
    }
    return p;
}

static void mutex_init(pthread_mutex_t *m)
{
    int rc = pthread_mutex_init(m, NULL);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_init");
    }
}

static void mutex_lock(pthread_mutex_t *m)
{
    int rc = pthread_mutex_lock(m);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_lock");
    }
}

static void mutex_unlock(pthread_mutex_t *m)
{
    int rc = pthread_mutex_unlock(m);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_unlock");
    }
}

static double seconds_since(const struct timespec *start)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return 0.0;
    }
    return (double)(now.tv_sec - start->tv_sec) +
           (double)(now.tv_nsec - start->tv_nsec) / 1e9;
}

static void logger_init(logger_t *log, const config_t *cfg)
{
    memset(log, 0, sizeof(*log));
    log->level = cfg->log_level;
    if (clock_gettime(CLOCK_MONOTONIC, &log->start) != 0) {
        die("clock_gettime");
    }
    mutex_init(&log->lock);
    (void)setvbuf(stdout, NULL, _IOLBF, 0);
}

static void logger_destroy(logger_t *log)
{
    (void)pthread_mutex_destroy(&log->lock);
}

static void log_msg(logger_t *log, int level, const char *fmt, ...)
{
    if (level > log->level) {
        return;
    }

    double t = seconds_since(&log->start);
    mutex_lock(&log->lock);
    fprintf(stdout, "[%8.3f] ", t);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stdout, fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
    mutex_unlock(&log->lock);
}

static void gate_init(gate_t *gate)
{
    memset(gate, 0, sizeof(*gate));
    mutex_init(&gate->lock);
    int rc = pthread_cond_init(&gate->cond, NULL);
    if (rc != 0) {
        errno = rc;
        die("pthread_cond_init");
    }
}

static void gate_destroy(gate_t *gate)
{
    (void)pthread_cond_destroy(&gate->cond);
    (void)pthread_mutex_destroy(&gate->lock);
}

static int gate_wait(gate_t *gate)
{
    mutex_lock(&gate->lock);
    while (!gate->open) {
        int rc = pthread_cond_wait(&gate->cond, &gate->lock);
        if (rc != 0) {
            errno = rc;
            die("pthread_cond_wait");
        }
    }
    int aborted = gate->abort;
    mutex_unlock(&gate->lock);
    return aborted;
}

static void gate_release(gate_t *gate, int abort_all)
{
    mutex_lock(&gate->lock);
    gate->open = 1;
    gate->abort = abort_all;
    int rc = pthread_cond_broadcast(&gate->cond);
    if (rc != 0) {
        errno = rc;
        die("pthread_cond_broadcast");
    }
    mutex_unlock(&gate->lock);
}

static void buffer_init(buffer_t *buf, size_t capacity)
{
    memset(buf, 0, sizeof(*buf));
    buf->capacity = capacity;
    buf->slots = xcalloc(capacity, sizeof(*buf->slots));

    if (sem_init(&buf->empty, 0, (unsigned int)capacity) != 0) {
        die("sem_init(empty)");
    }
    buf->empty_ok = 1;
    if (sem_init(&buf->full, 0, 0u) != 0) {
        die("sem_init(full)");
    }
    buf->full_ok = 1;
    if (sem_init(&buf->mutex, 0, 1u) != 0) {
        die("sem_init(mutex)");
    }
    buf->mutex_ok = 1;
}

static void buffer_destroy(buffer_t *buf)
{
    if (buf->mutex_ok) {
        (void)sem_destroy(&buf->mutex);
    }
    if (buf->full_ok) {
        (void)sem_destroy(&buf->full);
    }
    if (buf->empty_ok) {
        (void)sem_destroy(&buf->empty);
    }
    free(buf->slots);
    buf->slots = NULL;
}

static void wait_sem(sem_t *sem, const char *name)
{
    while (sem_wait(sem) != 0) {
        if (errno == EINTR) {
            continue;
        }
        die(name);
    }
}

static void post_sem(sem_t *sem, const char *name)
{
    if (sem_post(sem) != 0) {
        die(name);
    }
}

static void buffer_put(buffer_t *buf, item_t item, size_t *slot_out, size_t *count_out)
{
    wait_sem(&buf->empty, "sem_wait(empty)");
    wait_sem(&buf->mutex, "sem_wait(mutex)");

    size_t slot = buf->in;
    buf->slots[slot] = item;
    buf->in = (buf->in + 1) % buf->capacity;
    buf->count++;
    if (buf->count > buf->max_count) {
        buf->max_count = buf->count;
    }
    *slot_out = slot;
    *count_out = buf->count;

    post_sem(&buf->mutex, "sem_post(mutex)");
    post_sem(&buf->full, "sem_post(full)");
}

static item_t buffer_get(buffer_t *buf, size_t *slot_out, size_t *count_out)
{
    wait_sem(&buf->full, "sem_wait(full)");
    wait_sem(&buf->mutex, "sem_wait(mutex)");

    size_t slot = buf->out;
    item_t item = buf->slots[slot];
    buf->out = (buf->out + 1) % buf->capacity;
    buf->count--;
    *slot_out = slot;
    *count_out = buf->count;

    post_sem(&buf->mutex, "sem_post(mutex)");
    post_sem(&buf->empty, "sem_post(empty)");
    return item;
}

static void verifier_init(verifier_t *verify, const config_t *cfg, size_t expected)
{
    memset(verify, 0, sizeof(*verify));
    verify->enabled = cfg->verify;
    verify->nbits = expected;
    verify->producers = (size_t)cfg->producers;
    verify->items_per_producer = cfg->items_per_producer;
    mutex_init(&verify->lock);
    if (verify->enabled) {
        verify->bits = xcalloc((expected + 7u) / 8u, sizeof(*verify->bits));
    }
}

static void verifier_destroy(verifier_t *verify)
{
    free(verify->bits);
    verify->bits = NULL;
    (void)pthread_mutex_destroy(&verify->lock);
}

static void verifier_record(verifier_t *verify, item_t item)
{
    if (!verify->enabled) {
        return;
    }

    int bad = 0;
    if (item.producer_id < 1 || (size_t)item.producer_id > verify->producers ||
        item.seq < 1 || (size_t)item.seq > verify->items_per_producer) {
        bad = 1;
    }

    size_t idx = 0;
    if (!bad) {
        idx = ((size_t)item.producer_id - 1u) * verify->items_per_producer +
              ((size_t)item.seq - 1u);
        if (idx >= verify->nbits) {
            bad = 1;
        }
    }

    mutex_lock(&verify->lock);
    if (bad) {
        verify->invalid++;
    } else {
        size_t byte = idx / 8u;
        unsigned char mask = (unsigned char)(1u << (idx % 8u));
        if ((verify->bits[byte] & mask) != 0) {
            verify->duplicate++;
        } else {
            verify->bits[byte] |= mask;
            verify->unique++;
        }
    }
    mutex_unlock(&verify->lock);
}

static void sleep_ms(int ms)
{
    if (ms <= 0) {
        return;
    }
    struct timespec req;
    struct timespec rem;
    req.tv_sec = ms / 1000;
    req.tv_nsec = (long)(ms % 1000) * 1000000L;
    while (nanosleep(&req, &rem) != 0) {
        if (errno != EINTR) {
            die("nanosleep");
        }
        req = rem;
    }
}

static int jitter_ms(int base_ms, unsigned int *state)
{
    if (base_ms <= 0) {
        return 0;
    }
    unsigned int span = (unsigned int)base_ms;
    return base_ms + (int)(rand_r(state) % (span + 1u));
}

static void producer_run(worker_t *worker)
{
    const config_t *cfg = worker->cfg;
    for (int seq = 1; seq <= (int)cfg->items_per_producer; seq++) {
        if (cfg->prod_delay_ms > 0) {
            sleep_ms(jitter_ms(cfg->prod_delay_ms, &worker->rng));
        }

        item_t item;
        item.kind = ITEM_DATA;
        item.producer_id = worker->id;
        item.seq = seq;

        size_t slot = 0;
        size_t count = 0;
        buffer_put(worker->buf, item, &slot, &count);
        worker->produced++;

        if (cfg->log_level >= 2 ||
            seq == 1 || seq == (int)cfg->items_per_producer ||
            (seq % 1000) == 0) {
            int level = cfg->log_level >= 2 ? 2 : 1;
            log_msg(worker->log, level,
                    "[P%d] put item=%d:%d slot=%zu count=%zu/%zu",
                    worker->id, worker->id, seq, slot, count,
                    worker->buf->capacity);
        }
    }
    log_msg(worker->log, 1, "[P%d] done produced=%zu", worker->id, worker->produced);
}

static void consumer_run(worker_t *worker)
{
    const config_t *cfg = worker->cfg;
    for (;;) {
        size_t slot = 0;
        size_t count = 0;
        item_t item = buffer_get(worker->buf, &slot, &count);

        if (item.kind == ITEM_STOP) {
            log_msg(worker->log, 1, "[C%d] stop slot=%zu count=%zu/%zu",
                    worker->id, slot, count, worker->buf->capacity);
            break;
        }

        worker->consumed++;
        verifier_record(worker->verify, item);

        if (cfg->log_level >= 2 ||
            worker->consumed == 1 ||
            worker->consumed % 1000 == 0) {
            int level = cfg->log_level >= 2 ? 2 : 1;
            log_msg(worker->log, level,
                    "[C%d] get item=%d:%d slot=%zu count=%zu/%zu",
                    worker->id, item.producer_id, item.seq, slot, count,
                    worker->buf->capacity);
            if (cfg->log_level >= 2) {
                log_msg(worker->log, 2, "[C%d] done item=%d:%d",
                        worker->id, item.producer_id, item.seq);
            }
        }

        if (cfg->cons_delay_ms > 0) {
            sleep_ms(jitter_ms(cfg->cons_delay_ms, &worker->rng));
        }
    }
    log_msg(worker->log, 1, "[C%d] done consumed=%zu", worker->id, worker->consumed);
}

static void *worker_main(void *arg)
{
    worker_t *worker = (worker_t *)arg;
    if (gate_wait(worker->gate)) {
        return NULL;
    }
    if (worker->is_producer) {
        producer_run(worker);
    } else {
        consumer_run(worker);
    }
    return NULL;
}

static void print_usage(FILE *out)
{
    fprintf(out,
            "Usage: pc_sem [options]\n"
            "  -p, --producers N        producer threads (1-64, default 3)\n"
            "  -c, --consumers N        consumer threads (1-64, default 3)\n"
            "  -b, --buffer N           buffer capacity (1-4096, default 5)\n"
            "  -n, --items N            items per producer (1-1000000, default 20)\n"
            "      --prod-delay-ms N    producer delay in ms (0-5000, default 10)\n"
            "      --cons-delay-ms N    consumer delay in ms (0-5000, default 15)\n"
            "      --log-level N        0=result, 1=lifecycle/sample, 2=per item (default 1)\n"
            "      --seed N             random delay seed (default 20261103)\n"
            "      --no-verify          disable duplicate/missing bitmap\n"
            "  -h, --help               show this help\n");
}

static int parse_int(const char *s, int min_value, int max_value, int *out)
{
    char *end = NULL;
    errno = 0;
    long value = strtol(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0' || value < min_value || value > max_value) {
        return -1;
    }
    *out = (int)value;
    return 0;
}

static int parse_size(const char *s, size_t min_value, size_t max_value, size_t *out)
{
    char *end = NULL;
    errno = 0;
    unsigned long long value = strtoull(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0' ||
        value < min_value || value > max_value) {
        return -1;
    }
    *out = (size_t)value;
    return 0;
}

static int parse_seed(const char *s, unsigned int *out)
{
    char *end = NULL;
    errno = 0;
    unsigned long value = strtoul(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0' || value > UINT_MAX) {
        return -1;
    }
    *out = (unsigned int)value;
    return 0;
}

static int parse_args(int argc, char **argv, config_t *cfg)
{
    static const struct option long_options[] = {
        {"producers", required_argument, NULL, 'p'},
        {"consumers", required_argument, NULL, 'c'},
        {"buffer", required_argument, NULL, 'b'},
        {"items", required_argument, NULL, 'n'},
        {"prod-delay-ms", required_argument, NULL, 1000},
        {"cons-delay-ms", required_argument, NULL, 1001},
        {"log-level", required_argument, NULL, 1002},
        {"seed", required_argument, NULL, 1003},
        {"no-verify", no_argument, NULL, 1004},
        {"help", no_argument, NULL, 'h'},
        {NULL, 0, NULL, 0}
    };

    opterr = 0;
    int opt;
    while ((opt = getopt_long(argc, argv, "p:c:b:n:h", long_options, NULL)) != -1) {
        switch (opt) {
        case 'p':
            if (parse_int(optarg, 1, MAX_PRODUCERS, &cfg->producers) != 0) {
                fprintf(stderr, "pc_sem: invalid --producers '%s'\n", optarg);
                return 2;
            }
            break;
        case 'c':
            if (parse_int(optarg, 1, MAX_CONSUMERS, &cfg->consumers) != 0) {
                fprintf(stderr, "pc_sem: invalid --consumers '%s'\n", optarg);
                return 2;
            }
            break;
        case 'b':
            if (parse_size(optarg, 1, MAX_BUFFER, &cfg->capacity) != 0) {
                fprintf(stderr, "pc_sem: invalid --buffer '%s'\n", optarg);
                return 2;
            }
            break;
        case 'n':
            if (parse_size(optarg, 1, MAX_ITEMS, &cfg->items_per_producer) != 0) {
                fprintf(stderr, "pc_sem: invalid --items '%s'\n", optarg);
                return 2;
            }
            break;
        case 1000:
            if (parse_int(optarg, 0, 5000, &cfg->prod_delay_ms) != 0) {
                fprintf(stderr, "pc_sem: invalid --prod-delay-ms '%s'\n", optarg);
                return 2;
            }
            break;
        case 1001:
            if (parse_int(optarg, 0, 5000, &cfg->cons_delay_ms) != 0) {
                fprintf(stderr, "pc_sem: invalid --cons-delay-ms '%s'\n", optarg);
                return 2;
            }
            break;
        case 1002:
            if (parse_int(optarg, 0, 2, &cfg->log_level) != 0) {
                fprintf(stderr, "pc_sem: invalid --log-level '%s'\n", optarg);
                return 2;
            }
            break;
        case 1003:
            if (parse_seed(optarg, &cfg->seed) != 0) {
                fprintf(stderr, "pc_sem: invalid --seed '%s'\n", optarg);
                return 2;
            }
            break;
        case 1004:
            cfg->verify = 0;
            break;
        case 'h':
            print_usage(stdout);
            return 1;
        default:
            fprintf(stderr, "pc_sem: unknown or incomplete option\n");
            return 2;
        }
    }

    if (optind < argc) {
        fprintf(stderr, "pc_sem: unexpected argument '%s'\n", argv[optind]);
        return 2;
    }

    if ((size_t)cfg->producers > MAX_TOTAL / cfg->items_per_producer) {
        fprintf(stderr, "pc_sem: producers * items exceeds %d\n", MAX_TOTAL);
        return 2;
    }

    return 0;
}

static int run_experiment(const config_t *cfg)
{
    logger_t log;
    buffer_t buf;
    verifier_t verify;
    gate_t gate;

    logger_init(&log, cfg);
    buffer_init(&buf, cfg->capacity);
    const size_t expected = (size_t)cfg->producers * cfg->items_per_producer;
    verifier_init(&verify, cfg, expected);
    gate_init(&gate);

    const size_t total_workers = (size_t)cfg->producers + (size_t)cfg->consumers;
    worker_t *workers = xcalloc(total_workers, sizeof(*workers));

    log_msg(&log, 1,
            "[MAIN] start producers=%d consumers=%d buffer=%zu items=%zu verify=%s seed=%u",
            cfg->producers, cfg->consumers, cfg->capacity,
            cfg->items_per_producer, cfg->verify ? "on" : "off", cfg->seed);

    int create_failed = 0;
    size_t created = 0;

    for (int i = 0; i < cfg->producers; i++) {
        worker_t *w = &workers[(size_t)i];
        w->id = i + 1;
        w->is_producer = 1;
        w->cfg = cfg;
        w->buf = &buf;
        w->log = &log;
        w->verify = &verify;
        w->gate = &gate;
        w->rng = cfg->seed ^ ((unsigned int)w->id * 2654435761u) ^ 0x9e3779b9u;

        int rc = pthread_create(&w->tid, NULL, worker_main, w);
        if (rc != 0) {
            fprintf(stderr, "FATAL: pthread_create(producer %d): %s\n", w->id, strerror(rc));
            create_failed = 1;
            break;
        }
        w->created = 1;
        created++;
    }

    if (!create_failed) {
        for (int i = 0; i < cfg->consumers; i++) {
            worker_t *w = &workers[(size_t)cfg->producers + (size_t)i];
            w->id = i + 1;
            w->is_producer = 0;
            w->cfg = cfg;
            w->buf = &buf;
            w->log = &log;
            w->verify = &verify;
            w->gate = &gate;
            w->rng = cfg->seed ^ ((unsigned int)w->id * 2654435761u) ^ 0x85ebca6bu;

            int rc = pthread_create(&w->tid, NULL, worker_main, w);
            if (rc != 0) {
                fprintf(stderr, "FATAL: pthread_create(consumer %d): %s\n", w->id, strerror(rc));
                create_failed = 1;
                break;
            }
            w->created = 1;
            created++;
        }
    }

    if (create_failed) {
        gate_release(&gate, 1);
        for (size_t i = 0; i < total_workers; i++) {
            if (workers[i].created) {
                int rc = pthread_join(workers[i].tid, NULL);
                if (rc != 0) {
                    errno = rc;
                    die("pthread_join");
                }
            }
        }
        free(workers);
        gate_destroy(&gate);
        verifier_destroy(&verify);
        buffer_destroy(&buf);
        logger_destroy(&log);
        return 1;
    }

    gate_release(&gate, 0);

    size_t produced = 0;
    for (int i = 0; i < cfg->producers; i++) {
        int rc = pthread_join(workers[(size_t)i].tid, NULL);
        if (rc != 0) {
            errno = rc;
            die("pthread_join(producer)");
        }
        produced += workers[(size_t)i].produced;
    }

    for (int i = 0; i < cfg->consumers; i++) {
        item_t stop;
        stop.kind = ITEM_STOP;
        stop.producer_id = 0;
        stop.seq = 0;

        size_t slot = 0;
        size_t count = 0;
        buffer_put(&buf, stop, &slot, &count);
        log_msg(&log, 1, "[MAIN] stop slot=%zu count=%zu/%zu",
                slot, count, buf.capacity);
    }

    size_t consumed = 0;
    for (int i = 0; i < cfg->consumers; i++) {
        worker_t *w = &workers[(size_t)cfg->producers + (size_t)i];
        int rc = pthread_join(w->tid, NULL);
        if (rc != 0) {
            errno = rc;
            die("pthread_join(consumer)");
        }
        consumed += w->consumed;
    }

    size_t unique = verify.enabled ? verify.unique : consumed;
    size_t duplicate = verify.enabled ? verify.duplicate : 0;
    size_t invalid = verify.enabled ? verify.invalid : 0;
    size_t missing = expected >= unique ? expected - unique : 0;

    int empty_value = -1;
    int full_value = -1;
    int mutex_value = -1;
    if (sem_getvalue(&buf.empty, &empty_value) != 0 ||
        sem_getvalue(&buf.full, &full_value) != 0 ||
        sem_getvalue(&buf.mutex, &mutex_value) != 0) {
        fprintf(stderr, "WARN: sem_getvalue failed: %s\n", strerror(errno));
    }

    if (empty_value != (int)cfg->capacity || full_value != 0 || mutex_value != 1) {
        fprintf(stderr,
                "WARN: final semaphore state empty=%d full=%d mutex=%d (expected %zu/0/1)\n",
                empty_value, full_value, mutex_value, cfg->capacity);
    }

    int pass = produced == expected &&
               consumed == expected &&
               unique == expected &&
               duplicate == 0 &&
               invalid == 0 &&
               missing == 0 &&
               buf.count == 0 &&
               buf.max_count <= cfg->capacity &&
               empty_value == (int)cfg->capacity &&
               full_value == 0 &&
               mutex_value == 1;

    double elapsed = seconds_since(&log.start);
    printf("RESULT produced=%zu consumed=%zu expected=%zu unique=%zu "
           "duplicate=%zu missing=%zu invalid=%zu max_count=%zu "
           "elapsed=%.3fs status=%s\n",
           produced, consumed, expected, unique, duplicate, missing,
           invalid, buf.max_count, elapsed, pass ? "PASS" : "FAIL");
    fflush(stdout);

    free(workers);
    gate_destroy(&gate);
    verifier_destroy(&verify);
    buffer_destroy(&buf);
    logger_destroy(&log);

    return pass ? 0 : 1;
}

int main(int argc, char **argv)
{
    config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.producers = 3;
    cfg.consumers = 3;
    cfg.capacity = 5;
    cfg.items_per_producer = 20;
    cfg.prod_delay_ms = 10;
    cfg.cons_delay_ms = 15;
    cfg.log_level = 1;
    cfg.seed = 20261103u;
    cfg.verify = 1;

    int parse_result = parse_args(argc, argv, &cfg);
    if (parse_result == 1) {
        return 0;
    }
    if (parse_result == 2) {
        print_usage(stderr);
        return 2;
    }

    return run_experiment(&cfg);
}
