#ifndef CHANNELWIRE_PROTOCOL_H
#define CHANNELWIRE_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define CW_FRAME_HEADER_SIZE 5u
#define CW_MAX_PAYLOAD_SIZE 4096u
#define CW_MAX_STRING_SIZE 1024u

typedef enum {
    CW_MSG_HELLO = 1,
    CW_MSG_JOIN = 2,
    CW_MSG_SWITCH = 3,
    CW_MSG_LEAVE = 4,
    CW_MSG_SAY = 5,
    CW_MSG_DM = 6,
    CW_MSG_WHO = 7,
    CW_MSG_LIST = 8,
    CW_MSG_NICK = 9,
    CW_MSG_QUIT = 10,
} cw_client_msg_type;

typedef enum {
    CW_MSG_OK = 101,
    CW_MSG_ERROR = 102,
    CW_MSG_CHAT = 103,
    CW_MSG_DM_RECV = 104,
    CW_MSG_SYSTEM = 105,
    CW_MSG_WHO_RESP = 106,
    CW_MSG_LIST_RESP = 107,
    CW_MSG_STATS_RESP = 108,
} cw_server_msg_type;

typedef struct {
    uint8_t type;
    uint32_t payload_len;
} cw_frame_header;

int cw_parse_header(const uint8_t *buf, size_t len, cw_frame_header *out);
size_t cw_write_header(uint8_t *buf, uint8_t type, uint32_t payload_len);

int cw_read_string(const uint8_t *payload,
                   size_t payload_len,
                   size_t *offset,
                   char *out,
                   size_t out_cap);

int cw_write_string(uint8_t *payload,
                    size_t payload_cap,
                    size_t *offset,
                    const char *value);

int cw_valid_name(const char *value, size_t min_len, size_t max_len);

#endif
