#define _GNU_SOURCE
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdbool.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Debian 12's userspace headers predate this runtime ABI flag. */
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

static int allow(int ruleset, const char *path, __u64 rights) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        perror(path);
        return -1;
    }
    struct landlock_path_beneath_attr rule = {
        .allowed_access = rights,
        .parent_fd = fd,
    };
    int result = syscall(SYS_landlock_add_rule, ruleset,
                         LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
    close(fd);
    if (result < 0) {
        perror(path);
    }
    return result;
}

int main(int argc, char **argv) {
    if (argc < 2 || syscall(SYS_landlock_create_ruleset, NULL, 0,
                            LANDLOCK_CREATE_RULESET_VERSION) < 3) {
        fputs("workspace-install unavailable: Landlock ABI 3 or newer is required.\n", stderr);
        return 1;
    }

    const __u64 read = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    const __u64 execute = read | LANDLOCK_ACCESS_FS_EXECUTE;
    const __u64 write = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE |
                        LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
                        LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
                        LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_MAKE_FIFO |
                        LANDLOCK_ACCESS_FS_REFER;
    struct landlock_ruleset_attr policy = {
        .handled_access_fs = execute | write | LANDLOCK_ACCESS_FS_MAKE_SOCK |
                             LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK,
    };
    int ruleset = syscall(SYS_landlock_create_ruleset, &policy, sizeof(policy), 0);
    if (ruleset < 0) {
        perror("workspace-install ruleset");
        return 1;
    }

    /* Never grant the shared temporary directory or the mounted workspace,
       account profile, credentials, attachments and connected folders. */
    if (allow(ruleset, "/app", execute) ||
        allow(ruleset, "/usr", execute | write) ||
        allow(ruleset, "/etc", read | write) ||
        allow(ruleset, "/var/lib", execute | write) ||
        allow(ruleset, "/var/cache", read | write) ||
        allow(ruleset, "/var/log", read | write) ||
        allow(ruleset, "/var/spool", read | write) ||
        allow(ruleset, "/proc", read) ||
        allow(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE) ||
        allow(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE) ||
        allow(ruleset, "/dev/random", LANDLOCK_ACCESS_FS_READ_FILE) ||
        allow(ruleset, "/run/workspace-packages", read | write | LANDLOCK_ACCESS_FS_MAKE_SOCK) ||
        prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) ||
        syscall(SYS_landlock_restrict_self, ruleset, 0)) {
        fputs("workspace-install unavailable: could not enforce the filesystem policy.\n", stderr);
        return 1;
    }
    close(ruleset);
    execv(argv[1], &argv[1]);
    perror("workspace-install broker");
    return 1;
}
