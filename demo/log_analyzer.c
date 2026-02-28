/*
 * log_analyzer.c — Realistic log file analyzer (original, unoptimized)
 *
 * Parses Apache-style access logs, aggregates:
 *   - IP request counts (hash table with linear probing)
 *   - HTTP status code distribution
 *   - Latency percentiles (p50/p95/p99 via qsort)
 *
 * Written "normally" — competent C, no ARM-specific tricks.
 * Designed to process ~4M lines for meaningful perf profiling.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define HASH_SIZE   (1 << 17)   /* 131072 slots */
#define MAX_LINE    1024
#define INIT_LAT    (1 << 20)   /* initial latency array capacity */

/* ── Array-of-Structures hash table ─────────────────────────────────────── */

typedef struct {
    char ip[48];
    int  count;
    double total_time;
} IPEntry;

static IPEntry ip_table[HASH_SIZE];
static int     ip_table_size = 0;

/* djb2 hash */
static unsigned int hash_ip(const char *s) {
    unsigned int h = 5381;
    while (*s)
        h = ((h << 5) + h) + (unsigned char)*s++;
    return h;
}

/* Linear-probe lookup / insert.  Uses strcmp for comparison. */
static IPEntry *find_or_insert(const char *ip) {
    unsigned int h = hash_ip(ip) & (HASH_SIZE - 1);
    for (int i = 0; i < HASH_SIZE; i++) {
        IPEntry *e = &ip_table[h];
        if (e->count == 0) {                    /* empty → insert */
            strncpy(e->ip, ip, sizeof(e->ip) - 1);
            e->ip[sizeof(e->ip) - 1] = '\0';
            ip_table_size++;
            return e;
        }
        if (strcmp(e->ip, ip) == 0) return e;   /* found */
        h = (h + 1) & (HASH_SIZE - 1);
    }
    return NULL;
}

/* ── Statistics ─────────────────────────────────────────────────────────── */

static int    status_counts[600];
static double *latencies;
static int    lat_count, lat_cap;
static int    total_lines, parse_errors;

static void add_latency(double t) {
    if (lat_count >= lat_cap) {
        lat_cap *= 2;
        latencies = realloc(latencies, lat_cap * sizeof(double));
    }
    latencies[lat_count++] = t;
}

/* ── Line parser ────────────────────────────────────────────────────────── */

/*
 * Format: IP - - [date] "METHOD /path HTTP/1.1" STATUS SIZE TIME_MS
 */
static int parse_line(const char *line, char *ip_out,
                      int *status_out, double *time_out)
{
    /* IP: first space-delimited token */
    const char *p = line;
    int i = 0;
    while (*p && *p != ' ' && i < 47)
        ip_out[i++] = *p++;
    ip_out[i] = '\0';
    if (i == 0) return -1;

    /* Skip to closing quote of the request string */
    const char *q1 = strchr(p, '"');
    if (!q1) return -1;
    const char *q2 = strchr(q1 + 1, '"');
    if (!q2) return -1;

    /* Status code */
    p = q2 + 1;
    while (*p == ' ') p++;
    *status_out = atoi(p);
    if (*status_out < 100 || *status_out > 599) return -1;

    /* Skip status, skip size, read time */
    while (*p && *p != ' ') p++;
    while (*p == ' ') p++;
    while (*p && *p != ' ') p++;
    while (*p == ' ') p++;
    *time_out = atof(p);
    return 0;
}

/* ── Comparators ────────────────────────────────────────────────────────── */

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static int cmp_ip_count(const void *a, const void *b) {
    return ((const IPEntry *)b)->count - ((const IPEntry *)a)->count;
}

/* ── Log generator ──────────────────────────────────────────────────────── */

static void generate_log(const char *path, int n) {
    FILE *f = fopen(path, "w");
    if (!f) { perror("fopen"); exit(1); }

    srand(42);
    const char *meths[]  = {"GET","POST","PUT","DELETE","PATCH"};
    const char *paths[]  = {"/api/users","/api/products","/api/orders",
                            "/index.html","/api/search","/api/auth/login",
                            "/static/app.js","/api/cart","/health",
                            "/api/notifications"};
    int codes[] = {200,200,200,200,200,201,204,301,400,403,404,404,500,502,503};

    char buf[512];
    for (int i = 0; i < n; i++) {
        int cls = rand() % 100, a, b, c, d;
        if (cls < 30)      { a=10;  b=0;   c=rand()%4;   d=rand()%10+1; }   /* ~40 IPs */
        else if (cls < 60) { a=192; b=168; c=rand()%8;   d=rand()%50+1; }   /* ~400 IPs */
        else if (cls < 85) { a=172; b=16;  c=rand()%16;  d=rand()%64+1; }   /* ~1024 IPs */
        else               { a=rand()%50+1; b=rand()%32; c=rand()%16; d=rand()%16; }  /* ~4K IPs */

        int st = codes[rand() % 15];
        double rt = 0.5 + (rand() % 1000) * 0.1;
        if (rand() % 20 == 0)  rt += 500.0;
        if (rand() % 100 == 0) rt += 5000.0;

        int len = snprintf(buf, sizeof(buf),
            "%d.%d.%d.%d - - [28/Feb/2026:10:%02d:%02d +0000] "
            "\"%s %s HTTP/1.1\" %d %d %.1f\n",
            a,b,c,d, (i/3600)%60, (i/60)%60,
            meths[rand()%5], paths[rand()%10], st, rand()%50000+100, rt);
        fwrite(buf, 1, len, f);
    }
    fclose(f);
}

/* ── Main ───────────────────────────────────────────────────────────────── */

static void reset_state(void) {
    memset(ip_table, 0, sizeof(ip_table));
    ip_table_size = 0;
    memset(status_counts, 0, sizeof(status_counts));
    lat_count = 0;
    total_lines = 0;
    parse_errors = 0;
}

int main(int argc, char **argv) {
    int num_lines = 500000;
    const char *logfile = "/tmp/access.log";
    int passes = 30;  /* re-analyze the file multiple times for stable profiling */
    int skip_gen = 0;
    if (argc > 1) num_lines = atoi(argv[1]);
    if (argc > 2) passes = atoi(argv[2]);
    if (argc > 3 && strcmp(argv[3], "-s") == 0) skip_gen = 1;

    /* Phase 1: generate (skip with -s flag, useful for profiling) */
    if (!skip_gen) {
        printf("Generating %d log lines to %s ...\n", num_lines, logfile);
        generate_log(logfile, num_lines);
    } else {
        printf("Skipping generation, using existing %s\n", logfile);
    }

    /* Phase 2: analyze (timed) — run 'passes' iterations, keep last results */
    printf("Analyzing (%d passes) ...\n", passes);
    lat_cap = INIT_LAT;
    latencies = malloc(lat_cap * sizeof(double));

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    for (int pass = 0; pass < passes; pass++) {
        reset_state();

        FILE *f = fopen(logfile, "r");
        if (!f) { perror("fopen"); return 1; }

        char line[MAX_LINE];
        char ip[48];
        int  status;
        double rtime;

        while (fgets(line, sizeof(line), f)) {
            total_lines++;
            if (parse_line(line, ip, &status, &rtime) != 0) {
                parse_errors++;
                continue;
            }
            IPEntry *e = find_or_insert(ip);
            if (e) { e->count++; e->total_time += rtime; }
            status_counts[status]++;
            add_latency(rtime);
        }
        fclose(f);
    }

    /* Sort latencies for percentiles */
    qsort(latencies, lat_count, sizeof(double), cmp_double);

    clock_gettime(CLOCK_MONOTONIC, &t1);
    double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;

    /* ── Output ── */
    printf("\n=== Log Analysis Results ===\n");
    printf("Lines processed: %d\n", total_lines);
    printf("Parse errors:    %d\n", parse_errors);
    printf("Unique IPs:      %d\n", ip_table_size);
    printf("Analysis time:   %.3f s  (%.0f lines/sec)\n\n",
           elapsed, total_lines / elapsed);

    printf("Status Distribution:\n");
    for (int s = 100; s < 600; s++)
        if (status_counts[s] > 0)
            printf("  %d: %7d  (%5.1f%%)\n", s, status_counts[s],
                   100.0 * status_counts[s] / total_lines);

    printf("\nLatency Percentiles:\n");
    printf("  p50: %.1f ms\n", latencies[lat_count * 50 / 100]);
    printf("  p95: %.1f ms\n", latencies[lat_count * 95 / 100]);
    printf("  p99: %.1f ms\n", latencies[lat_count * 99 / 100]);

    qsort(ip_table, HASH_SIZE, sizeof(IPEntry), cmp_ip_count);
    printf("\nTop 10 IPs:\n");
    for (int i = 0; i < 10 && ip_table[i].count > 0; i++)
        printf("  %-20s %7d reqs  avg %.1f ms\n",
               ip_table[i].ip, ip_table[i].count,
               ip_table[i].total_time / ip_table[i].count);

    free(latencies);
    return 0;
}
