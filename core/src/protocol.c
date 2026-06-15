#include "channelwire/protocol.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <string.h>

int cw_parse_header(const uint8_t *buf, size_t len, cw_frame_header *out) {
    uint32_t net_len;

    if (buf == NULL || out == NULL || len < CW_FRAME_HEADER_SIZE) {
        return -1;
    }

    memcpy(&net_len, buf + 1, sizeof(net_len));
    out->type = buf[0];
    out->payload_len = ntohl(net_len);

    if (out->payload_len > CW_MAX_PAYLOAD_SIZE) {
        return -1;
    }

    return 0;
}

size_t cw_write_header(uint8_t *buf, uint8_t type, uint32_t payload_len) {
    uint32_t net_len = htonl(payload_len);

    buf[0] = type;
    memcpy(buf + 1, &net_len, sizeof(net_len));
    return CW_FRAME_HEADER_SIZE;
}

int cw_read_string(const uint8_t *payload,
                   size_t payload_len,
                   size_t *offset,
                   char *out,
                   size_t out_cap) {
    uint16_t net_len;
    uint16_t str_len;

    if (payload == NULL || offset == NULL || out == NULL || out_cap == 0) {
        return -1;
    }
    if (*offset + sizeof(net_len) > payload_len) {
        return -1;
    }

    memcpy(&net_len, payload + *offset, sizeof(net_len));
    str_len = ntohs(net_len);
    *offset += sizeof(net_len);

    if (str_len > CW_MAX_STRING_SIZE || *offset + str_len > payload_len) {
        return -1;
    }
    if ((size_t)str_len >= out_cap) {
        return -1;
    }

    memcpy(out, payload + *offset, str_len);
    out[str_len] = '\0';
    *offset += str_len;
    return 0;
}

int cw_write_string(uint8_t *payload,
                    size_t payload_cap,
                    size_t *offset,
                    const char *value) {
    size_t len;
    uint16_t net_len;

    if (payload == NULL || offset == NULL || value == NULL) {
        return -1;
    }

    len = strlen(value);
    if (len > UINT16_MAX || len > CW_MAX_STRING_SIZE) {
        return -1;
    }
    if (*offset + sizeof(net_len) + len > payload_cap) {
        return -1;
    }

    net_len = htons((uint16_t)len);
    memcpy(payload + *offset, &net_len, sizeof(net_len));
    *offset += sizeof(net_len);
    memcpy(payload + *offset, value, len);
    *offset += len;
    return 0;
}

int cw_valid_name(const char *value, size_t min_len, size_t max_len) {
    size_t len;

    if (value == NULL) {
        return 0;
    }

    len = strlen(value);
    if (len < min_len || len > max_len) {
        return 0;
    }

    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)value[i];
        if (!(isalnum(c) || c == '_' || c == '-' || c == '.')) {
            return 0;
        }
    }

    return 1;
}
