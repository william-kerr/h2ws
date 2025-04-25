# Create Self-Signed SSL Certificate

To generate a private key and self-signed certificate for local development, run:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout example.key -out example.crt -days 365 -subj "/CN=localhost"
```
