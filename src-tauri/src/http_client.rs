use reqwest::{redirect::Policy, ClientBuilder, Url};

const MAX_CREDENTIALED_REDIRECTS: usize = 5;

/// Builds the shared client used for requests carrying Portcode credentials.
/// Redirects remain useful for provider endpoints, but are bounded and may
/// never change scheme, host, or effective port.
pub(crate) fn credentialed_client_builder() -> ClientBuilder {
    reqwest::Client::builder().redirect(credentialed_redirect_policy())
}

fn credentialed_redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_CREDENTIALED_REDIRECTS {
            return attempt.error(std::io::Error::other(
                "credentialed redirect limit exceeded",
            ));
        }

        let Some(previous) = attempt.previous().last() else {
            return attempt.error(std::io::Error::other(
                "credentialed redirect origin unavailable",
            ));
        };

        if same_origin(previous, attempt.url()) {
            attempt.follow()
        } else {
            attempt.error(std::io::Error::other(
                "credentialed redirect changed origin",
            ))
        }
    })
}

fn same_origin(previous: &Url, next: &Url) -> bool {
    previous.scheme() == next.scheme()
        && previous.host() == next.host()
        && previous.port_or_known_default() == next.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        time::{timeout, Duration},
    };

    async fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0u8; 2048];

        loop {
            let read = stream.read(&mut buffer).await.expect("request read failed");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);

            let Some(headers_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers_end = headers_end + 4;
            let headers = String::from_utf8_lossy(&request[..headers_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= headers_end + content_length {
                break;
            }
        }

        request
    }

    #[tokio::test]
    async fn rejects_cross_origin_redirect_before_credentials_or_body_reach_target() {
        let redirect_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect_address = redirect_listener.local_addr().unwrap();
        let target_address = target_listener.local_addr().unwrap();

        let redirect_server = tokio::spawn(async move {
            let (mut stream, _) = redirect_listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            assert!(request
                .windows(b"refresh-secret".len())
                .any(|part| part == b"refresh-secret"));
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{target_address}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let client = credentialed_client_builder().no_proxy().build().unwrap();
        let result = client
            .post(format!("http://{redirect_address}/token"))
            .bearer_auth("bearer-secret")
            .header("x-api-key", "api-secret")
            .header("ChatGPT-Account-ID", "account-secret")
            .body("refresh-secret")
            .send()
            .await;

        assert!(result.is_err());
        redirect_server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(250), target_listener.accept())
                .await
                .is_err(),
            "redirect target unexpectedly received a connection"
        );
    }

    #[tokio::test]
    async fn follows_a_bounded_same_origin_redirect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let first_request = read_request(&mut first).await;
            assert!(String::from_utf8_lossy(&first_request).starts_with("POST /start "));
            first
                .write_all(
                    b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /finish\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();

            let (mut second, _) = listener.accept().await.unwrap();
            let second_request = read_request(&mut second).await;
            let second_text = String::from_utf8_lossy(&second_request);
            assert!(second_text.starts_with("POST /finish "));
            assert!(second_text
                .to_ascii_lowercase()
                .contains("authorization: bearer bearer-secret"));
            assert!(second_request
                .windows(b"request-body".len())
                .any(|part| part == b"request-body"));
            second
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
        });

        let client = credentialed_client_builder().no_proxy().build().unwrap();
        let response = client
            .post(format!("http://{address}/start"))
            .bearer_auth("bearer-secret")
            .body("request-body")
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "ok");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn follows_exactly_five_redirects_before_rejecting_the_sixth() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            // One initial request plus five permitted redirect targets. The
            // sixth redirect response must be rejected before a seventh request.
            for hop in 0..=MAX_CREDENTIALED_REDIRECTS {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_request(&mut stream).await;
                assert!(String::from_utf8_lossy(&request).starts_with(&format!("GET /hop-{hop} ")));
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 302 Found\r\nLocation: /hop-{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            hop + 1
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }

            assert!(
                timeout(Duration::from_millis(250), listener.accept())
                    .await
                    .is_err(),
                "the redirect limit allowed an unexpected seventh request"
            );
        });

        let client = credentialed_client_builder().no_proxy().build().unwrap();
        let result = timeout(
            Duration::from_secs(2),
            client.get(format!("http://{address}/hop-0")).send(),
        )
        .await
        .expect("redirect limit must terminate the request");

        assert!(result.is_err());
        timeout(Duration::from_secs(2), server)
            .await
            .expect("redirect test server must finish")
            .unwrap();
    }
}
