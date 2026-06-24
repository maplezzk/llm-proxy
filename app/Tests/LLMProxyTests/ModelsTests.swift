import XCTest
@testable import LLMProxy

final class ModelsTests: XCTestCase {

    // MARK: - TokenStats

    func testTokenRecordDecoding() throws {
        let json = """
        {
            "date": "2026-05-28",
            "input_tokens": 150,
            "output_tokens": 80,
            "cache_read_input_tokens": 20,
            "cache_creation_input_tokens": 5,
            "request_count": 12
        }
        """
        let data = json.data(using: .utf8)!
        let record = try JSONDecoder().decode(TokenRecord.self, from: data)

        XCTAssertEqual(record.date, "2026-05-28")
        XCTAssertEqual(record.input_tokens, 150)
        XCTAssertEqual(record.output_tokens, 80)
        XCTAssertEqual(record.cache_read_input_tokens, 20)
        XCTAssertEqual(record.cache_creation_input_tokens, 5)
        XCTAssertEqual(record.request_count, 12)
    }

    func testTokenStatsResponseDecoding() throws {
        let json = """
        {
            "success": true,
            "data": {
                "today": {
                    "date": "2026-05-28",
                    "input_tokens": 300,
                    "output_tokens": 200,
                    "cache_read_input_tokens": 40,
                    "cache_creation_input_tokens": 10,
                    "request_count": 25
                },
                "history": [],
                "byProvider": {
                    "deepseek": {
                        "date": "2026-05-28",
                        "input_tokens": 180,
                        "output_tokens": 120,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0,
                        "request_count": 15
                    }
                }
            }
        }
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(TokenStatsResponse.self, from: data)

        XCTAssertTrue(resp.success)
        XCTAssertEqual(resp.data?.today.input_tokens, 300)
        XCTAssertEqual(resp.data?.byProvider["deepseek"]?.output_tokens, 120)
    }

    func testTokenStatsResponseWithNullData() throws {
        let json = """
        {"success": false, "data": null}
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(TokenStatsResponse.self, from: data)

        XCTAssertFalse(resp.success)
        XCTAssertNil(resp.data)
    }

    // MARK: - Token Usage Charts (持久化层)

    func testTimelinePointDecoding() throws {
        let json = """
        {
            "date": "2026-05-28",
            "input_tokens": 1000,
            "output_tokens": 500,
            "cache_read_input_tokens": 300,
            "cache_creation_input_tokens": 50,
            "request_count": 10
        }
        """
        let data = json.data(using: .utf8)!
        let point = try JSONDecoder().decode(TimelinePoint.self, from: data)

        XCTAssertEqual(point.date, "2026-05-28")
        XCTAssertEqual(point.shortDate, "05-28")
        XCTAssertEqual(point.input_tokens, 1000)
        XCTAssertEqual(point.cache_read_input_tokens, 300)
        XCTAssertEqual(point.request_count, 10)
    }

    func testTimelineArrayResponseDecoding() throws {
        let json = """
        {
            "success": true,
            "data": [
                {"date": "2026-05-27", "input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "request_count": 1},
                {"date": "2026-05-28", "input_tokens": 200, "output_tokens": 100, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 10, "request_count": 5}
            ]
        }
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(ArrayResponse<TimelinePoint>.self, from: data)

        XCTAssertTrue(resp.success)
        XCTAssertEqual(resp.data?.count, 2)
        XCTAssertEqual(resp.data?[1].input_tokens, 200)
    }

    func testUsageBucketDecoding() throws {
        let json = """
        {
            "key": "codex",
            "input_tokens": 500,
            "output_tokens": 200,
            "cache_read_input_tokens": 100,
            "cache_creation_input_tokens": 0,
            "request_count": 8
        }
        """
        let data = json.data(using: .utf8)!
        let bucket = try JSONDecoder().decode(UsageBucket.self, from: data)

        XCTAssertEqual(bucket.key, "codex")
        XCTAssertEqual(bucket.totalTokens, 700)
        XCTAssertEqual(bucket.request_count, 8)
    }

    func testUsageBucketWithEmptyKeyReplacedByBackend() throws {
        // 后端把空 adapter key 替换为 "(direct proxy)"
        let json = """
        {"key": "(direct proxy)", "input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "request_count": 3}
        """
        let data = json.data(using: .utf8)!
        let bucket = try JSONDecoder().decode(UsageBucket.self, from: data)
        XCTAssertEqual(bucket.key, "(direct proxy)")
    }

    func testTokenDbInfoDecoding() throws {
        let json = """
        {"success": true, "data": {"events": 1234, "aggregates": 89, "sizeBytes": 49152}}
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(InfoResponse<TokenDbInfo>.self, from: data)

        XCTAssertTrue(resp.success)
        XCTAssertEqual(resp.data?.events, 1234)
        XCTAssertEqual(resp.data?.aggregates, 89)
        XCTAssertEqual(resp.data?.sizeBytes, 49152)
    }

    func testCleanupResponseDecoding() throws {
        let json = """
        {"success": true, "data": {"days": 90, "events": 100, "aggregates": 10}}
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(CleanupResponse.self, from: data)

        XCTAssertTrue(resp.success)
        XCTAssertEqual(resp.data?.days, 90)
        XCTAssertEqual(resp.data?.events, 100)
        XCTAssertEqual(resp.data?.aggregates, 10)
    }

    // MARK: - LogEntry

    func testLogEntryDecoding() throws {
        let json = """
        {
            "id": 1,
            "timestamp": "2026-05-28 14:30:00.123",
            "type": "request",
            "level": "info",
            "message": "GET /v1/messages 200",
            "details": {"status": 200, "latency": 150}
        }
        """
        let data = json.data(using: .utf8)!
        let entry = try JSONDecoder().decode(LogEntry.self, from: data)

        XCTAssertEqual(entry.id, 1)
        XCTAssertEqual(entry.type, "request")
        XCTAssertEqual(entry.level, "info")
        XCTAssertEqual(entry.message, "GET /v1/messages 200")
        XCTAssertNotNil(entry.details)
    }

    func testLogEntryWithoutDetails() throws {
        let json = """
        {
            "id": 2,
            "timestamp": "2026-05-28 14:30:01.456",
            "type": "system",
            "level": "warn",
            "message": "Config file not found"
        }
        """
        let data = json.data(using: .utf8)!
        let entry = try JSONDecoder().decode(LogEntry.self, from: data)

        XCTAssertEqual(entry.id, 2)
        XCTAssertNil(entry.details)
    }

    func testLogsResponseDecoding() throws {
        let json = """
        {
            "success": true,
            "data": {
                "logs": [
                    {"id": 1, "timestamp": "2026-05-28 14:30:00.000", "type": "system", "level": "info", "message": "Server started"}
                ],
                "stats": {"total": 100, "requestCount": 60, "systemCount": 40}
            }
        }
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(LogsResponse.self, from: data)

        XCTAssertTrue(resp.success)
        XCTAssertEqual(resp.data?.logs.count, 1)
        XCTAssertEqual(resp.data?.stats?.total, 100)
        XCTAssertEqual(resp.data?.stats?.requestCount, 60)
    }

    // MARK: - CaptureEntry

    func testCaptureEntryDecoding() throws {
        let json = """
        {
            "id": 1,
            "timestamp": 1716892200000,
            "source": "proxy",
            "protocol": "anthropic",
            "model": "claude-sonnet-4",
            "pairId": 1,
            "requestIn": "{\\"model\\":\\"claude-sonnet-4\\"}",
            "requestOut": "{\\"model\\":\\"claude-sonnet-4-20250514\\"}",
            "responseIn": "{\\"content\\":\\"Hello\\"}",
            "responseOut": "{\\"content\\":\\"Hello\\"}",
            "adapterName": null,
            "upstreamProvider": "anthropic",
            "upstreamProtocol": "anthropic",
            "upstreamModel": "claude-sonnet-4-20250514"
        }
        """
        let data = json.data(using: .utf8)!
        let entry = try JSONDecoder().decode(CaptureEntry.self, from: data)

        XCTAssertEqual(entry.id, 1)
        XCTAssertEqual(entry.source, "proxy")
        XCTAssertEqual(entry.protocol, "anthropic")
        XCTAssertEqual(entry.upstreamProvider, "anthropic")
    }

    func testCaptureStatusDecoding() throws {
        let json = """
        {"success": true, "data": {"enabled": true}}
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(CaptureStatusResponse.self, from: data)

        XCTAssertTrue(resp.success)
        XCTAssertEqual(resp.data?.enabled, true)
    }

    // MARK: - ProviderDetail

    func testProviderDetailDecoding() throws {
        let json = """
        {
            "name": "deepseek",
            "type": "openai",
            "api_key": "sk-xxx",
            "api_base": "https://api.deepseek.com",
            "models": [
                {"id": "deepseek-chat", "thinking": null, "reasoning_effort": null},
                {"id": "deepseek-reasoner", "thinking": null, "reasoning_effort": "high"}
            ]
        }
        """
        let data = json.data(using: .utf8)!
        let provider = try JSONDecoder().decode(ProviderDetail.self, from: data)

        XCTAssertEqual(provider.name, "deepseek")
        XCTAssertEqual(provider.models.count, 2)
        XCTAssertEqual(provider.models[1].reasoning_effort, "high")
    }

    func testProviderDetailWithThinking() throws {
        let json = """
        {
            "name": "anthropic",
            "type": "anthropic",
            "api_key": "sk-xxx",
            "api_base": "https://api.anthropic.com",
            "models": [
                {"id": "claude-sonnet-4", "thinking": {"budget_tokens": 1024}, "reasoning_effort": null}
            ]
        }
        """
        let data = json.data(using: .utf8)!
        let provider = try JSONDecoder().decode(ProviderDetail.self, from: data)

        XCTAssertEqual(provider.models[0].thinking?.budget_tokens, 1024)
        XCTAssertNil(provider.models[0].reasoning_effort)
    }

    // MARK: - TestModelResult

    func testTestModelResultDecoding() throws {
        let json = """
        {"success": true, "data": {"reachable": true, "latency": 250, "model": "test", "error": null, "adapterUrl": null, "requestUrl": null, "requestBody": null, "responseBody": null, "responseStatus": 200}}
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(TestModelResponse.self, from: data)

        XCTAssertTrue(resp.data?.reachable == true)
        XCTAssertEqual(resp.data?.latency, 250)
        XCTAssertNil(resp.data?.error)
    }
}
