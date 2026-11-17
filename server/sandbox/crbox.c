/* Defence in depth in a shared kernel, not a VM or a kernel escape boundary. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* Both supported architectures use the generic numbers for these new calls.
 * No linux/landlock.h dependency: Ubuntu's older headers must build this too. */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif
#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION 1
#define LANDLOCK_RULE_PATH_BENEATH 1
struct landlock_ruleset_attr { uint64_t handled_access_fs; };
struct landlock_path_beneath_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));
#endif
#ifndef __NR_clone3
#define __NR_clone3 435
#endif
#ifndef __NR_pidfd_getfd
#define __NR_pidfd_getfd 438
#endif
#ifndef __NR_process_madvise
#define __NR_process_madvise 440
#endif
#ifndef __NR_mount_setattr
#define __NR_mount_setattr 442
#endif
#ifndef __NR_close_range
#define __NR_close_range 436
#endif
#ifndef __NR_open_tree
#define __NR_open_tree 428
#define __NR_move_mount 429
#define __NR_fsopen 430
#define __NR_fsconfig 431
#define __NR_fsmount 432
#define __NR_fspick 433
#endif
#define LL_EXECUTE (1ULL << 0)
#define LL_WRITE (1ULL << 1)
#define LL_READ (1ULL << 2)
#define LL_READDIR (1ULL << 3)
#define LL_TRUNCATE (1ULL << 14)
#define LL_IOCTL (1ULL << 15)
#define NEW_FLAGS 0x7e020080U /* NEW{NS,CGROUP,UTS,IPC,USER,PID,NET,TIME} */

static void die(const char *what) { fprintf(stderr, "crbox: %s: %s\n", what, strerror(errno)); exit(126); }
static int abi(void) { return (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION); }
static uint64_t access_mask(int v) {
    uint64_t m = (1ULL << 13) - 1;
    if (v >= 2) m |= 1ULL << 13; /* REFER */
    if (v >= 3) m |= LL_TRUNCATE;
    if (v >= 5) m |= LL_IOCTL;
    return m;
}
struct rule { const char *path; int rw; };
static int landlock(struct rule *rules, int count) {
    int v = abi(); if (v < 1) return -1;
    struct landlock_ruleset_attr attr = { .handled_access_fs = access_mask(v) };
    int fd = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (fd < 0) return -1;
    for (int i = 0; i < count; i++) {
        int p = open(rules[i].path, O_PATH | O_CLOEXEC);
        if (p < 0) { int e = errno; close(fd); errno = e; return -1; }
        struct stat st;
        if (fstat(p, &st)) { int e = errno; close(p); close(fd); errno = e; return -1; }
        uint64_t rights = rules[i].rw ? attr.handled_access_fs : LL_EXECUTE | LL_READ | LL_READDIR;
        if (!S_ISDIR(st.st_mode)) rights &= LL_EXECUTE | LL_READ | LL_WRITE | LL_TRUNCATE | LL_IOCTL;
        struct landlock_path_beneath_attr r = { .allowed_access = rights, .parent_fd = p };
        int rc = (int)syscall(__NR_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &r, 0);
        int e = errno; close(p);
        if (rc) { close(fd); errno = e; return -1; }
    }
    int rc = (int)syscall(__NR_landlock_restrict_self, fd, 0);
    int e = errno; close(fd); errno = e; return rc;
}

static struct sock_filter filter[512];
static unsigned int nf;
static void stmt(unsigned short code, unsigned int k) { filter[nf++] = (struct sock_filter)BPF_STMT(code,k); }
static void jump(unsigned short code, unsigned int k, unsigned char jt, unsigned char jf) { filter[nf++] = (struct sock_filter)BPF_JUMP(code,k,jt,jf); }
static void deny(unsigned int nr, int err) {
    jump(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1);
    stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (unsigned int)err);
}
static int seccomp(int no_net) {
    nf = 0;
    stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
#if defined(__x86_64__)
    jump(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
#elif defined(__aarch64__)
    jump(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0);
#else
#error crbox only supports x86_64 and aarch64
#endif
    stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#if defined(__x86_64__)
    jump(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1);
    stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
#endif
    const int blocked[] = {
#ifdef __NR_ptrace
        __NR_ptrace,
#endif
#ifdef __NR_process_vm_readv
        __NR_process_vm_readv, __NR_process_vm_writev,
#endif
        __NR_mount, __NR_umount2, __NR_pivot_root, __NR_chroot, __NR_unshare, __NR_setns,
        __NR_bpf, __NR_perf_event_open, __NR_kexec_load,
#ifdef __NR_kexec_file_load
        __NR_kexec_file_load,
#endif
        __NR_init_module, __NR_finit_module, __NR_delete_module,
        __NR_keyctl, __NR_add_key, __NR_request_key, __NR_userfaultfd,
#ifdef __NR_io_uring_setup
        __NR_io_uring_setup, __NR_io_uring_enter, __NR_io_uring_register,
#endif
        __NR_open_by_handle_at, __NR_name_to_handle_at, __NR_swapon, __NR_swapoff, __NR_reboot,
        __NR_settimeofday, __NR_clock_settime, __NR_adjtimex, __NR_clock_adjtime,
        __NR_acct, __NR_quotactl, __NR_syslog,
#ifdef __NR_iopl
        __NR_iopl, __NR_ioperm,
#endif
        __NR_move_pages, __NR_mbind, __NR_set_mempolicy, __NR_migrate_pages,
#ifdef __NR_lookup_dcookie
        __NR_lookup_dcookie,
#endif
        __NR_vhangup, __NR_mount_setattr, __NR_fsopen, __NR_fsconfig,
        __NR_fsmount, __NR_fspick, __NR_open_tree, __NR_move_mount,
        __NR_pidfd_getfd, __NR_process_madvise, __NR_kcmp,
        /* Keep descendants in the launcher's process group so killTree works. */
        __NR_setsid, __NR_setpgid
    };
    for (unsigned int i = 0; i < sizeof(blocked)/sizeof(blocked[0]); i++) deny((unsigned int)blocked[i], EPERM);
    deny(__NR_clone3, ENOSYS); /* glibc must be able to fall back to clone. */
    jump(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4);
    stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
    jump(BPF_JMP | BPF_JSET | BPF_K, NEW_FLAGS, 0, 1);
    stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
    jump(BPF_JMP | BPF_JEQ | BPF_K, __NR_personality, 0, 8);
    stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
    const unsigned int personalities[] = { 0, 0x0008, 0x20000, 0x20008, 0xffffffffU };
    for (unsigned int i = 0; i < 5; i++) jump(BPF_JMP | BPF_JEQ | BPF_K, personalities[i], (unsigned char)(5-i), 0);
    stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
    if (no_net) {
        /* The native ABIs have separate socket calls. Reject any unexpected
         * family too (e.g. AF_VSOCK); allow only local AF_UNIX IPC. */
        jump(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0);
        jump(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 0, 4);
        stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
        jump(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0);
        stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES);
        stmt(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#ifdef __NR_socketcall
        deny(__NR_socketcall, EACCES);
#endif
    }
    stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
    struct sock_fprog prog = { .len = (unsigned short)nf, .filter = filter };
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);
}

static int child_probe(int which) {
    pid_t p = fork(); if (p < 0) return 0;
    if (p == 0) {
        if (which == 0) _exit(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ? 1 : 0);
        if (which == 1) {
            if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || seccomp(0)) _exit(1);
            errno = 0;
            long rc = syscall(__NR_ptrace, 0, 0, 0, 0);
            _exit(rc == -1 && errno == EPERM ? 0 : 1);
        }
        if (which == 2) {
            if (geteuid() != 0 || setgroups(0, NULL) || setgid(65534) || setuid(65534)) _exit(1);
            _exit(setuid(0) == -1 && geteuid() == 65534 ? 0 : 1);
        }
        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || landlock(NULL, 0)) _exit(1);
        errno = 0; int fd = open("/etc/passwd", O_RDONLY);
        if (fd >= 0) { close(fd); _exit(1); }
        _exit(errno == EACCES ? 0 : 1);
    }
    int status;
    while (waitpid(p, &status, 0) < 0) { if (errno != EINTR) return 0; }
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
static unsigned long long number(const char *s) {
    char *end = NULL; errno = 0;
    unsigned long long n = strtoull(s, &end, 10);
    if (errno || !*s || *s == '-' || !end || *end) { errno = EINVAL; die("invalid number"); }
    return n;
}
static void limit(int resource, unsigned long long n) {
    struct rlimit l = { (rlim_t)n, (rlim_t)n };
    if ((unsigned long long)l.rlim_cur != n || setrlimit(resource, &l)) die("setrlimit");
}
static void close_extra(void) {
    if (syscall(__NR_close_range, 3U, ~0U, 0) == 0) return;
    DIR *d = opendir("/proc/self/fd");
    if (d) {
        struct dirent *ent; int own = dirfd(d);
        while ((ent = readdir(d))) { int fd = atoi(ent->d_name); if (fd > 2 && fd != own) close(fd); }
        closedir(d); return;
    }
    /* Do not rely on the reduced NOFILE limit: inherited fds may exceed it. */
    for (int fd = 3; fd < 1048576; fd++) close(fd);
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--probe")) {
        int v = abi(); if (v < 1 || !child_probe(3)) v = 0;
        printf("{\"landlock\":%d,\"seccomp\":%s,\"root\":%s,\"setuid\":%s,\"nnp\":%s}\n",
            v, child_probe(1)?"true":"false", geteuid()==0?"true":"false", child_probe(2)?"true":"false", child_probe(0)?"true":"false");
        return 0;
    }
    int ll = 0, sc = 0, net = 0, sid = 0, allow = 0, uid_set = 0, gid_set = 0;
    uid_t uid = 0; gid_t gid = 0; const char *cwd = NULL;
    unsigned long long cpu = 0, fsize = 0, nproc = 0, nofile = 0;
    int have_cpu = 0, have_fsize = 0, have_nproc = 0, have_nofile = 0;
    struct rule *rules = calloc((size_t)argc, sizeof(*rules)); if (!rules) die("calloc");
    int nr = 0, i;
    for (i = 1; i < argc; i++) {
        const char *arg = argv[i]; if (!strcmp(arg, "--")) { i++; break; }
        if (!strcmp(arg, "--landlock")) ll = 1;
        else if (!strcmp(arg, "--seccomp")) sc = 1;
        else if (!strcmp(arg, "--no-net")) net = 1;
        else if (!strcmp(arg, "--setsid")) sid = 1;
        else if (!strcmp(arg, "--allow-missing")) allow = 1;
        else {
            if (i + 1 >= argc) { errno = EINVAL; die("option needs a value"); }
            const char *v = argv[++i];
            if (!strcmp(arg, "--ro") || !strcmp(arg, "--rw")) rules[nr++] = (struct rule){v, !strcmp(arg,"--rw")};
            else if (!strcmp(arg, "--chdir")) cwd = v;
            else if (!strcmp(arg, "--uid")) { unsigned long long n=number(v); uid=(uid_t)n; if(n!=(unsigned long long)uid || uid==0) {errno=EINVAL;die("uid must be nonzero");} uid_set=1; }
            else if (!strcmp(arg, "--gid")) { unsigned long long n=number(v); gid=(gid_t)n; if(n!=(unsigned long long)gid) {errno=EINVAL;die("gid");} gid_set=1; }
            else if (!strcmp(arg, "--rlimit-cpu")) { cpu = number(v); have_cpu = 1; }
            else if (!strcmp(arg, "--rlimit-fsize")) { fsize = number(v); if(fsize>ULLONG_MAX/(1024*1024)) {errno=EINVAL;die("file limit");} have_fsize = 1; }
            else if (!strcmp(arg, "--rlimit-nproc")) { nproc = number(v); have_nproc = 1; }
            else if (!strcmp(arg, "--rlimit-nofile")) { nofile = number(v); have_nofile = 1; }
            else if (!strcmp(arg, "--rlimit-core") && number(v)==0) { /* Always zero. */ }
            else { errno = EINVAL; die("unknown option"); }
        }
    }
    if (i >= argc) { errno = EINVAL; die("expected -- program [args]"); }
    if (have_cpu) limit(RLIMIT_CPU, cpu);
    if (have_fsize) limit(RLIMIT_FSIZE, fsize * 1024 * 1024);
    if (have_nproc) limit(RLIMIT_NPROC, nproc);
    if (have_nofile) limit(RLIMIT_NOFILE, nofile);
    limit(RLIMIT_CORE, 0);
    if (sid && setsid() < 0) die("setsid");
    if (uid_set || gid_set) {
        if (!uid_set || !gid_set || geteuid() != 0) { errno = EPERM; die("uid/gid drop requires root and both IDs"); }
        if (setgroups(0, NULL)) die("setgroups");
        if (setgid(gid)) die("setgid");
        if (setuid(uid)) die("setuid");
        if (setuid(0) != -1 || geteuid() != uid || getegid() != gid) { errno = EPERM; die("uid drop was reversible"); }
    }
    if (cwd && chdir(cwd)) die("chdir");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) {
        if (!allow) die("no_new_privs");
        fprintf(stderr, "crbox: no_new_privs unavailable: %s\n", strerror(errno));
    }
    if (ll && landlock(rules, nr)) {
        if (!allow) die("Landlock");
        fprintf(stderr, "crbox: Landlock unavailable: %s\n", strerror(errno));
    }
    free(rules);
    if ((sc || net) && seccomp(net)) {
        if (!allow) die("seccomp");
        fprintf(stderr, "crbox: seccomp unavailable: %s\n", strerror(errno));
    }
    close_extra();
    execvp(argv[i], argv + i); die("execvp");
}
