# 实验一：信号量通信实验

多线程生产者–消费者模型，使用 **C11 + pthread + POSIX 无名信号量** 实现有界环形缓冲区。

## 目录

```text
embedded/
├── Makefile
├── README.md
├── src/
│   └── pc_sem.c
├── tests/
│   └── run_tests.sh
└── docs/
```

## 同步模型

| 信号量 | 初值 | 作用 |
|---|---:|---|
| `empty` | N | 空槽许可；生产者写入前申请 |
| `full` | 0 | 数据许可；消费者取出前申请 |
| `mutex` | 1 | 二值信号量，保护 `slots/in/out/count` |

生产者完成 K 次生产后，main 汇合全部生产者，再注入 C 个 `ITEM_STOP`；每个消费者取到 STOP 后退出。

## 构建

```bash
make
```

要求：Linux、GCC/Clang、POSIX 线程与信号量。Ubuntu 26.04 + GCC 15.2 已实测。

## 运行

```bash
./pc_sem
./pc_sem --producers 3 --consumers 3 --buffer 5 --items 20 --log-level 2
```

常用参数：

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `-p, --producers` | 3 | 生产者线程数，1–64 |
| `-c, --consumers` | 3 | 消费者线程数，1–64 |
| `-b, --buffer` | 5 | 缓冲区容量，1–4096 |
| `-n, --items` | 20 | 每个生产者生产的数据项数，1–1,000,000 |
| `--prod-delay-ms` | 10 | 生产延时，0–5000 ms |
| `--cons-delay-ms` | 15 | 消费延时，0–5000 ms |
| `--log-level` | 1 | 0=仅结果；1=生命周期/抽样；2=逐项 |
| `--seed` | 20261103 | 随机延时种子 |
| `--no-verify` | 关闭 | 关闭逐项重复/缺失校验 |
| `-h, --help` | — | 用法 |

结果行示例：

```text
RESULT produced=60 consumed=60 expected=60 unique=60 duplicate=0 missing=0 invalid=0 max_count=5 elapsed=0.412s status=PASS
```

## 测试

```bash
make test
```

测试脚本覆盖：

- T1 单生产者/单消费者
- T2 基本并发
- T3 缓冲区满阻塞
- T4 缓冲区空阻塞
- T5 40 万项压力测试
- T6 大容量缓冲区
- T7 非法参数
- T8 ASan + UBSan
- T9 TSan
- T10 重复运行 20 次

单独构建 Sanitizer 版本：

```bash
make sanitize   # ./pc_sem_asan
make tsan       # ./pc_sem_tsan
```

## 实测结果

在 `mc`（Ubuntu 26.04 / GCC 15.2.0）上执行完整测试矩阵：

```text
TEST_SUMMARY passed=15 failed=0
```

其中 40 万项压力测试：

```text
RESULT produced=400000 consumed=400000 expected=400000 unique=400000
       duplicate=0 missing=0 invalid=0 max_count=64 elapsed=0.290s status=PASS
```

完整记录见 `docs/test-report.txt`。

## 设计文档

设计文档位于 `docs/design.docx`。核心约定：

- 生产者：`wait(empty) → wait(mutex) → 写入 → post(mutex) → post(full)`
- 消费者：`wait(full) → wait(mutex) → 读取 → post(mutex) → post(empty)`
- 临界区内不等待另一把信号量，避免死锁。

## 远端运行

```bash
ssh mc
cd ~/embedded
make
./tests/run_tests.sh
```
