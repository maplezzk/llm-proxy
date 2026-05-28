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
        {"success": true, "data": {"ok": true, "latency_ms": 250, "error": null}}
        """
        let data = json.data(using: .utf8)!
        let resp = try JSONDecoder().decode(TestModelResponse.self, from: data)

        XCTAssertTrue(resp.data?.ok == true)
        XCTAssertEqual(resp.data?.latency_ms, 250)
        XCTAssertNil(resp.data?.error)
    }
}
