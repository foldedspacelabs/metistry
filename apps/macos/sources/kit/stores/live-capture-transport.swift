// The bar's wire to the live-capture bridge — the one place outside
// console-client.swift that makes an HTTP request, and the one place in this
// app that sets an `Authorization` header.
//
// Why a second HTTP client at all: plan §2.2 — "controlling a recording: the
// app talks to the local live-capture bridge directly", no CLI and no API.
// Why it is safe to have one: it can reach exactly one origin and five
// routes, and the bearer it sets is only ever the recorder's control key.
//
//   * ONE ORIGIN. `http://127.0.0.1:7815` — the bridge's manifest port
//     (packages/mcp-live-capture/manifest.yaml; a test holds the two
//     together). Loopback only: the bridge binds `127.0.0.1` and the control
//     key must never leave the Mac. No caller passes a URL; a caller passes a
//     `LiveCaptureRoute`, a closed enum.
//   * NO REDIRECTS. A redirect is refused outright, so the bearer can never
//     follow one somewhere else.
//   * NO STATE. An ephemeral session: no cookies, no cache, no credential
//     store — nothing about a request outlives it.
//   * THE KEY IS NEVER PRINTED. It is set on the request and nowhere else;
//     an error here carries URLSession's words, never the request.

import Foundation

public enum LiveCaptureBridge {
    /// The bridge's port — `port:` in packages/mcp-live-capture/manifest.yaml.
    public static let port = 7815
    /// Loopback, and nothing else: the bridge binds here (`METISTRY_LC_HOST`'s default).
    public static let host = "127.0.0.1"
    /// How long a read waits.
    public static let readTimeout: TimeInterval = 10
    /// How long a start waits: the macOS picker is abandoned after 120 s,
    /// and the bridge's own helper timeout is 150 s (`DEFAULT_HELPER_TIMEOUT_MS`).
    public static let startTimeout: TimeInterval = 155

    /// The URL a route goes to. There is no other way to build one here.
    public static func url(_ route: LiveCaptureRoute) -> URL {
        var parts = URLComponents()
        parts.scheme = "http"
        parts.host = host
        parts.port = port
        parts.path = route.path
        return parts.url!
    }
}

/// The production transport over `URLSession`.
public final class LoopbackLiveCaptureTransport: LiveCaptureTransport, @unchecked Sendable {
    // `@unchecked`: the only stored property is the session, created once and
    // never mutated; URLSession is thread-safe.
    private let session: URLSession

    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.connectionProxyDictionary = [:]
        let delegate = RedirectRefuser()
        self.session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }

    public func send(_ route: LiveCaptureRoute, body: Data?, key: LiveCaptureControlKey?) async -> LiveCaptureWireResult {
        var request = URLRequest(url: LiveCaptureBridge.url(route))
        request.httpMethod = route.method
        request.timeoutInterval = route == .start ? LiveCaptureBridge.startTimeout : LiveCaptureBridge.readTimeout
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let key {
            request.setValue(LiveCaptureBearer.header(key), forHTTPHeaderField: LiveCaptureBearer.field)
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed("the recorder's answer was not HTTP") }
            return .answered(status: http.statusCode, body: data)
        } catch let error as URLError {
            switch error.code {
            case .cannotConnectToHost, .cannotFindHost: return .noListener
            case .timedOut: return .failed("it did not answer in time")
            default: return .failed(error.localizedDescription)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

/// The bearer, spelled once.
enum LiveCaptureBearer {
    static let field = "Authorization"
    static func header(_ key: LiveCaptureControlKey) -> String { "Bearer " + key.value }
}

/// Refuses every redirect: the control key is for the bridge on this Mac and
/// nothing a response points at.
private final class RedirectRefuser: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}
