# OneNET MQTT TLS certificate

Source: OneNET official MQTT device connection documentation:
https://open.iot.10086.cn/doc/v5/fuse/detail/919

Official HTTPS download:
https://upfiles.heclouds.com/portal5-admin/portal5-admin/2023/12/12/42879ed2c2c1fe71739592773788bfd7.rar

Retrieved 2026-11-07; extracted certificate.pem without modification.
SHA-256 certificate fingerprint:
7D:E9:BC:4C:1A:ED:01:34:46:67:64:56:78:D4:49:74:12:10:B1:70:49:48:98:38:BF:63:79:53:B3:E9:01:17

This is a public server trust certificate, not a device credential or private key.
Never disable rejectUnauthorized to work around a certificate error.

The official server certificate is self-signed with CN=OneNET MQTTS and no DNS SAN.
The adapter keeps chain/expiry verification enabled and replaces DNS-name verification
with an exact SHA-256 leaf-certificate pin restricted to mqttstls.heclouds.com.
An official certificate rotation requires re-verifying the documentation, certificate,
and pin together. A changed certificate fails closed, not silently accepted.
