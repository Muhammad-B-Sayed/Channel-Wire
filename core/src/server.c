#include "channelwire/protocol.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#define CW_DEFAULT_PORT 5555
#define CW_BACKLOG 128
#define CW_MAX_CLIENTS 128
#define CW_MAX_CHANNELS 64
#define CW_NAME_CAP 32
#define CW_CHANNEL_CAP 32
#define CW_TEXT_CAP 1024
#define CW_INBUF_CAP (CW_FRAME_HEADER_SIZE + CW_MAX_PAYLOAD_SIZE)
#define CW_OUTBUF_CAP (CW_FRAME_HEADER_SIZE + CW_MAX_PAYLOAD_SIZE)
#define CW_MAX_QUEUE_BYTES (64u * 1024u)

typedef struct out_frame {
    uint8_t data[CW_OUTBUF_CAP];
    size_t len;
    size_t sent;
    struct out_frame *next;
} out_frame;

typedef struct {
    int fd;
    int registered;
    char username[CW_NAME_CAP + 1];
    char active_channel[CW_CHANNEL_CAP + 1];
    int joined[CW_MAX_CHANNELS];
    uint8_t inbuf[CW_INBUF_CAP];
    size_t inbuf_len;
    out_frame *out_head;
    out_frame *out_tail;
    size_t queued_bytes;
} client;

static client clients[CW_MAX_CLIENTS];
static char channels[CW_MAX_CHANNELS][CW_CHANNEL_CAP + 1];
static size_t channel_count;
static volatile sig_atomic_t running = 1;

static void handle_signal(int signo) {
    (void)signo;
    running = 0;
}

static void log_line(const char *fmt, ...) {
    va_list args;

    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fputc('\n', stderr);
}

static int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1) {
        return -1;
    }
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void init_clients(void) {
    for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
        clients[i].fd = -1;
    }
}

static void free_queue(client *c) {
    out_frame *cur = c->out_head;
    while (cur != NULL) {
        out_frame *next = cur->next;
        free(cur);
        cur = next;
    }
    c->out_head = NULL;
    c->out_tail = NULL;
    c->queued_bytes = 0;
}

static void reset_client(client *c) {
    if (c->fd >= 0) {
        close(c->fd);
    }
    free_queue(c);
    memset(c, 0, sizeof(*c));
    c->fd = -1;
}

static ssize_t find_client_by_fd(int fd) {
    for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
        if (clients[i].fd == fd) {
            return (ssize_t)i;
        }
    }
    return -1;
}

static int username_in_use(const char *username, const client *except) {
    for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
        if (&clients[i] != except && clients[i].fd >= 0 && clients[i].registered &&
            strcmp(clients[i].username, username) == 0) {
            return 1;
        }
    }
    return 0;
}

static ssize_t find_channel(const char *name) {
    for (size_t i = 0; i < channel_count; i++) {
        if (strcmp(channels[i], name) == 0) {
            return (ssize_t)i;
        }
    }
    return -1;
}

static ssize_t ensure_channel(const char *name) {
    ssize_t idx = find_channel(name);

    if (idx >= 0) {
        return idx;
    }
    if (channel_count >= CW_MAX_CHANNELS) {
        return -1;
    }

    snprintf(channels[channel_count], sizeof(channels[channel_count]), "%s", name);
    channel_count++;
    return (ssize_t)(channel_count - 1);
}

static int enqueue_payload(client *c, uint8_t type, const uint8_t *payload, size_t payload_len) {
    out_frame *frame;

    if (payload_len > CW_MAX_PAYLOAD_SIZE) {
        return -1;
    }
    if (c->queued_bytes + CW_FRAME_HEADER_SIZE + payload_len > CW_MAX_QUEUE_BYTES) {
        return -1;
    }

    frame = calloc(1, sizeof(*frame));
    if (frame == NULL) {
        return -1;
    }

    cw_write_header(frame->data, type, (uint32_t)payload_len);
    if (payload_len > 0 && payload != NULL) {
        memcpy(frame->data + CW_FRAME_HEADER_SIZE, payload, payload_len);
    }
    frame->len = CW_FRAME_HEADER_SIZE + payload_len;

    if (c->out_tail != NULL) {
        c->out_tail->next = frame;
    } else {
        c->out_head = frame;
    }
    c->out_tail = frame;
    c->queued_bytes += frame->len;
    return 0;
}

static int enqueue_text(client *c, uint8_t type, const char *text) {
    return enqueue_payload(c, type, (const uint8_t *)text, strlen(text));
}

static int enqueue_strings(client *c, uint8_t type, const char **values, size_t count) {
    uint8_t payload[CW_MAX_PAYLOAD_SIZE];
    size_t offset = 0;

    for (size_t i = 0; i < count; i++) {
        if (cw_write_string(payload, sizeof(payload), &offset, values[i]) != 0) {
            return -1;
        }
    }

    return enqueue_payload(c, type, payload, offset);
}

static void disconnect_client(client *c, const char *reason) {
    if (c->fd >= 0) {
        log_line("disconnect fd=%d reason=%s", c->fd, reason);
    }
    reset_client(c);
}

static int safe_enqueue_text(client *c, uint8_t type, const char *text) {
    if (enqueue_text(c, type, text) != 0) {
        disconnect_client(c, "outgoing queue overflow");
        return -1;
    }
    return 0;
}

static void broadcast_system(const char *text, const client *except) {
    for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
        if (&clients[i] != except && clients[i].fd >= 0 && clients[i].registered) {
            safe_enqueue_text(&clients[i], CW_MSG_SYSTEM, text);
        }
    }
}

static void broadcast_chat(client *sender, const char *text) {
    uint8_t payload[CW_MAX_PAYLOAD_SIZE];
    size_t offset = 0;
    const char *values[] = { sender->active_channel, sender->username, text };
    ssize_t channel_idx = find_channel(sender->active_channel);

    if (channel_idx < 0) {
        safe_enqueue_text(sender, CW_MSG_ERROR, "join a channel before sending");
        return;
    }

    for (size_t i = 0; i < 3; i++) {
        if (cw_write_string(payload, sizeof(payload), &offset, values[i]) != 0) {
            safe_enqueue_text(sender, CW_MSG_ERROR, "message payload too large");
            return;
        }
    }

    for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
        client *target = &clients[i];
        if (target->fd >= 0 && target->registered && target->joined[channel_idx]) {
            if (enqueue_payload(target, CW_MSG_CHAT, payload, offset) != 0) {
                disconnect_client(target, "outgoing queue overflow");
            }
        }
    }
}

static void send_who(client *c) {
    char payload[CW_MAX_PAYLOAD_SIZE];
    size_t used = 0;

    for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
        if (clients[i].fd >= 0 && clients[i].registered) {
            int written = snprintf(payload + used,
                                   sizeof(payload) - used,
                                   "%s%s",
                                   used == 0 ? "" : "\n",
                                   clients[i].username);
            if (written < 0 || (size_t)written >= sizeof(payload) - used) {
                safe_enqueue_text(c, CW_MSG_ERROR, "WHO response too large");
                return;
            }
            used += (size_t)written;
        }
    }

    safe_enqueue_text(c, CW_MSG_WHO_RESP, payload);
}

static void send_list(client *c) {
    char payload[CW_MAX_PAYLOAD_SIZE];
    size_t used = 0;

    for (size_t i = 0; i < channel_count; i++) {
        int written = snprintf(payload + used,
                               sizeof(payload) - used,
                               "%s%s",
                               used == 0 ? "" : "\n",
                               channels[i]);
        if (written < 0 || (size_t)written >= sizeof(payload) - used) {
            safe_enqueue_text(c, CW_MSG_ERROR, "LIST response too large");
            return;
        }
        used += (size_t)written;
    }

    safe_enqueue_text(c, CW_MSG_LIST_RESP, payload);
}

static int read_one_string_payload(const uint8_t *payload,
                                   size_t payload_len,
                                   char *out,
                                   size_t out_cap) {
    size_t offset = 0;
    if (cw_read_string(payload, payload_len, &offset, out, out_cap) != 0) {
        return -1;
    }
    return offset == payload_len ? 0 : -1;
}

static void handle_hello(client *c, const uint8_t *payload, size_t payload_len) {
    char username[CW_NAME_CAP + 1];
    char notice[128];

    if (read_one_string_payload(payload, payload_len, username, sizeof(username)) != 0 ||
        !cw_valid_name(username, 1, CW_NAME_CAP)) {
        safe_enqueue_text(c, CW_MSG_ERROR, "invalid username");
        return;
    }
    if (username_in_use(username, c)) {
        safe_enqueue_text(c, CW_MSG_ERROR, "username already in use");
        return;
    }

    snprintf(c->username, sizeof(c->username), "%s", username);
    c->registered = 1;
    safe_enqueue_text(c, CW_MSG_OK, "registered");

    snprintf(notice, sizeof(notice), "%s connected", c->username);
    broadcast_system(notice, c);
}

static void join_channel(client *c, const uint8_t *payload, size_t payload_len, int make_active) {
    char channel[CW_CHANNEL_CAP + 1];
    ssize_t channel_idx;
    char response[96];

    if (!c->registered) {
        safe_enqueue_text(c, CW_MSG_ERROR, "send HELLO first");
        return;
    }
    if (read_one_string_payload(payload, payload_len, channel, sizeof(channel)) != 0 ||
        !cw_valid_name(channel, 1, CW_CHANNEL_CAP)) {
        safe_enqueue_text(c, CW_MSG_ERROR, "invalid channel");
        return;
    }

    channel_idx = ensure_channel(channel);
    if (channel_idx < 0) {
        safe_enqueue_text(c, CW_MSG_ERROR, "too many channels");
        return;
    }

    c->joined[channel_idx] = 1;
    if (make_active) {
        snprintf(c->active_channel, sizeof(c->active_channel), "%s", channel);
    }

    snprintf(response, sizeof(response), "%s %s", make_active ? "joined" : "switched", channel);
    safe_enqueue_text(c, CW_MSG_OK, response);
}

static void leave_channel(client *c, const uint8_t *payload, size_t payload_len) {
    char channel[CW_CHANNEL_CAP + 1];
    ssize_t channel_idx;

    if (read_one_string_payload(payload, payload_len, channel, sizeof(channel)) != 0 ||
        !cw_valid_name(channel, 1, CW_CHANNEL_CAP)) {
        safe_enqueue_text(c, CW_MSG_ERROR, "invalid channel");
        return;
    }

    channel_idx = find_channel(channel);
    if (channel_idx < 0 || !c->joined[channel_idx]) {
        safe_enqueue_text(c, CW_MSG_ERROR, "not in channel");
        return;
    }

    c->joined[channel_idx] = 0;
    if (strcmp(c->active_channel, channel) == 0) {
        c->active_channel[0] = '\0';
    }
    safe_enqueue_text(c, CW_MSG_OK, "left channel");
}

static void handle_dm(client *c, const uint8_t *payload, size_t payload_len) {
    char target_name[CW_NAME_CAP + 1];
    char text[CW_TEXT_CAP + 1];
    size_t offset = 0;
    client *target = NULL;

    if (!c->registered) {
        safe_enqueue_text(c, CW_MSG_ERROR, "send HELLO first");
        return;
    }
    if (cw_read_string(payload, payload_len, &offset, target_name, sizeof(target_name)) != 0 ||
        cw_read_string(payload, payload_len, &offset, text, sizeof(text)) != 0 ||
        offset != payload_len || text[0] == '\0') {
        safe_enqueue_text(c, CW_MSG_ERROR, "invalid direct message");
        return;
    }

    for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
        if (clients[i].fd >= 0 && clients[i].registered &&
            strcmp(clients[i].username, target_name) == 0) {
            target = &clients[i];
            break;
        }
    }
    if (target == NULL) {
        safe_enqueue_text(c, CW_MSG_ERROR, "user not found");
        return;
    }

    {
        const char *values[] = { c->username, text };
        if (enqueue_strings(target, CW_MSG_DM_RECV, values, 2) != 0) {
            disconnect_client(target, "outgoing queue overflow");
            return;
        }
    }
    safe_enqueue_text(c, CW_MSG_OK, "direct message sent");
}

static void handle_nick(client *c, const uint8_t *payload, size_t payload_len) {
    char username[CW_NAME_CAP + 1];
    char old_name[CW_NAME_CAP + 1];
    char notice[160];

    if (read_one_string_payload(payload, payload_len, username, sizeof(username)) != 0 ||
        !cw_valid_name(username, 1, CW_NAME_CAP)) {
        safe_enqueue_text(c, CW_MSG_ERROR, "invalid username");
        return;
    }
    if (username_in_use(username, c)) {
        safe_enqueue_text(c, CW_MSG_ERROR, "username already in use");
        return;
    }

    snprintf(old_name, sizeof(old_name), "%s", c->username);
    snprintf(c->username, sizeof(c->username), "%s", username);
    c->registered = 1;
    safe_enqueue_text(c, CW_MSG_OK, "username changed");

    snprintf(notice, sizeof(notice), "%s is now %s", old_name[0] == '\0' ? "anonymous" : old_name, username);
    broadcast_system(notice, c);
}

static void handle_frame(client *c, uint8_t type, const uint8_t *payload, size_t payload_len) {
    char text[CW_TEXT_CAP + 1];

    switch (type) {
    case CW_MSG_HELLO:
        handle_hello(c, payload, payload_len);
        break;
    case CW_MSG_JOIN:
        join_channel(c, payload, payload_len, 1);
        break;
    case CW_MSG_SWITCH:
        join_channel(c, payload, payload_len, 1);
        break;
    case CW_MSG_LEAVE:
        leave_channel(c, payload, payload_len);
        break;
    case CW_MSG_SAY:
        if (!c->registered) {
            safe_enqueue_text(c, CW_MSG_ERROR, "send HELLO first");
        } else if (c->active_channel[0] == '\0') {
            safe_enqueue_text(c, CW_MSG_ERROR, "join a channel before sending");
        } else if (read_one_string_payload(payload, payload_len, text, sizeof(text)) != 0 ||
                   text[0] == '\0') {
            safe_enqueue_text(c, CW_MSG_ERROR, "invalid message");
        } else {
            broadcast_chat(c, text);
        }
        break;
    case CW_MSG_DM:
        handle_dm(c, payload, payload_len);
        break;
    case CW_MSG_WHO:
        send_who(c);
        break;
    case CW_MSG_LIST:
        send_list(c);
        break;
    case CW_MSG_NICK:
        handle_nick(c, payload, payload_len);
        break;
    case CW_MSG_QUIT:
        disconnect_client(c, "client quit");
        break;
    default:
        safe_enqueue_text(c, CW_MSG_ERROR, "unknown message type");
        break;
    }
}

static int drain_input(client *c) {
    while (c->inbuf_len >= CW_FRAME_HEADER_SIZE) {
        cw_frame_header header;
        size_t frame_len;

        if (cw_parse_header(c->inbuf, c->inbuf_len, &header) != 0) {
            safe_enqueue_text(c, CW_MSG_ERROR, "malformed frame");
            return -1;
        }

        frame_len = CW_FRAME_HEADER_SIZE + header.payload_len;
        if (c->inbuf_len < frame_len) {
            return 0;
        }

        handle_frame(c, header.type, c->inbuf + CW_FRAME_HEADER_SIZE, header.payload_len);
        if (c->fd < 0) {
            return -1;
        }

        memmove(c->inbuf, c->inbuf + frame_len, c->inbuf_len - frame_len);
        c->inbuf_len -= frame_len;
    }

    return 0;
}

static void read_from_client(client *c) {
    for (;;) {
        ssize_t n;

        if (c->inbuf_len == sizeof(c->inbuf)) {
            disconnect_client(c, "input buffer full");
            return;
        }

        n = recv(c->fd, c->inbuf + c->inbuf_len, sizeof(c->inbuf) - c->inbuf_len, 0);
        if (n > 0) {
            c->inbuf_len += (size_t)n;
            if (drain_input(c) != 0) {
                return;
            }
            continue;
        }
        if (n == 0) {
            disconnect_client(c, "peer closed");
            return;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return;
        }
        if (errno == EINTR) {
            continue;
        }

        disconnect_client(c, "recv failed");
        return;
    }
}

static void write_to_client(client *c) {
    while (c->out_head != NULL) {
        out_frame *frame = c->out_head;
        ssize_t n = send(c->fd, frame->data + frame->sent, frame->len - frame->sent, 0);

        if (n > 0) {
            frame->sent += (size_t)n;
            if (frame->sent == frame->len) {
                c->out_head = frame->next;
                if (c->out_head == NULL) {
                    c->out_tail = NULL;
                }
                c->queued_bytes -= frame->len;
                free(frame);
            }
            continue;
        }
        if (n == -1 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return;
        }
        if (n == -1 && errno == EINTR) {
            continue;
        }

        disconnect_client(c, "send failed");
        return;
    }
}

static int create_listener(const char *bind_host, int port) {
    int fd;
    int opt = 1;
    struct sockaddr_in addr;

    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return -1;
    }

    if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) != 0) {
        perror("setsockopt");
        close(fd);
        return -1;
    }

    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    if (inet_pton(AF_INET, bind_host, &addr.sin_addr) != 1) {
        perror("inet_pton");
        close(fd);
        return -1;
    }
    addr.sin_port = htons((uint16_t)port);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind");
        close(fd);
        return -1;
    }
    if (listen(fd, CW_BACKLOG) != 0) {
        perror("listen");
        close(fd);
        return -1;
    }
    if (set_nonblocking(fd) != 0) {
        perror("fcntl");
        close(fd);
        return -1;
    }

    return fd;
}

static void accept_clients(int listener_fd) {
    for (;;) {
        int fd = accept(listener_fd, NULL, NULL);
        client *slot = NULL;

        if (fd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                return;
            }
            if (errno == EINTR) {
                continue;
            }
            perror("accept");
            return;
        }

        for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
            if (clients[i].fd < 0) {
                slot = &clients[i];
                break;
            }
        }

        if (slot == NULL || set_nonblocking(fd) != 0) {
            close(fd);
            continue;
        }

        memset(slot, 0, sizeof(*slot));
        slot->fd = fd;
        log_line("accepted fd=%d", fd);
    }
}

static int parse_port(int argc, char **argv) {
    if (argc < 2) {
        return CW_DEFAULT_PORT;
    }

    char *end = NULL;
    long port = strtol(argv[1], &end, 10);
    if (end == argv[1] || *end != '\0' || port <= 0 || port > 65535) {
        fprintf(stderr, "usage: %s [port]\n", argv[0]);
        return -1;
    }
    return (int)port;
}

int main(int argc, char **argv) {
    int port = parse_port(argc, argv);
    const char *bind_host = getenv("CW_BIND_HOST");
    int listener_fd;

    if (port < 0) {
        return 2;
    }
    if (bind_host == NULL || bind_host[0] == '\0') {
        bind_host = "127.0.0.1";
    }

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);
    signal(SIGPIPE, SIG_IGN);

    init_clients();
    listener_fd = create_listener(bind_host, port);
    if (listener_fd < 0) {
        return 1;
    }

    log_line("channelwire server listening on %s:%d", bind_host, port);

    while (running) {
        struct pollfd pfds[CW_MAX_CLIENTS + 1];
        size_t nfds = 1;
        int rc;

        pfds[0].fd = listener_fd;
        pfds[0].events = POLLIN;
        pfds[0].revents = 0;

        for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
            if (clients[i].fd >= 0) {
                pfds[nfds].fd = clients[i].fd;
                pfds[nfds].events = POLLIN;
                if (clients[i].out_head != NULL) {
                    pfds[nfds].events |= POLLOUT;
                }
                pfds[nfds].revents = 0;
                nfds++;
            }
        }

        rc = poll(pfds, nfds, 250);
        if (rc < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("poll");
            break;
        }
        if (rc == 0) {
            continue;
        }

        if (pfds[0].revents & POLLIN) {
            accept_clients(listener_fd);
        }

        for (size_t i = 1; i < nfds; i++) {
            ssize_t client_idx = find_client_by_fd(pfds[i].fd);
            if (client_idx < 0) {
                continue;
            }

            if (pfds[i].revents & (POLLERR | POLLHUP | POLLNVAL)) {
                disconnect_client(&clients[client_idx], "poll error");
                continue;
            }
            if (pfds[i].revents & POLLIN) {
                read_from_client(&clients[client_idx]);
            }
            if (client_idx >= 0 && clients[client_idx].fd >= 0 && (pfds[i].revents & POLLOUT)) {
                write_to_client(&clients[client_idx]);
            }
        }
    }

    close(listener_fd);
    for (size_t i = 0; i < CW_MAX_CLIENTS; i++) {
        reset_client(&clients[i]);
    }

    return 0;
}
