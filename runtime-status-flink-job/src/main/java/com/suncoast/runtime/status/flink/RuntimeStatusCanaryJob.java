package com.suncoast.runtime.status.flink;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.flink.api.common.RuntimeExecutionMode;
import org.apache.flink.api.common.functions.MapFunction;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

import java.io.IOException;
import java.io.Serial;
import java.io.Serializable;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

public final class RuntimeStatusCanaryJob {
  private RuntimeStatusCanaryJob() {
  }

  public static void main(String[] args) throws Exception {
    Config config = Config.fromArgs(args);

    StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    env.setRuntimeMode(RuntimeExecutionMode.BATCH);
    env.setParallelism(1);

    env.fromData(config.definitionKey)
      .map(new RuntimeStatusCanaryInvoker(config))
      .name("invoke-runtime-status-canary")
      .setParallelism(1)
      .print()
      .name("print-runtime-status-canary-summary")
      .setParallelism(1);

    env.execute("Runtime Status Canary - " + config.definitionKey);
  }

  static final class RuntimeStatusCanaryInvoker implements MapFunction<String, String> {
    @Serial
    private static final long serialVersionUID = 1L;

    private final Config config;

    RuntimeStatusCanaryInvoker(Config config) {
      this.config = config;
    }

    @Override
    public String map(String definitionKey) throws Exception {
      ObjectMapper mapper = new ObjectMapper();
      String requestId = config.requestId.isBlank() ? UUID.randomUUID().toString() : config.requestId;
      JsonNode response = invokeRuntimeStatus(mapper, definitionKey, requestId);
      Evaluation evaluation = evaluate(mapper, definitionKey, requestId, response);
      if (!evaluation.ok) {
        throw new IllegalStateException(evaluation.summary);
      }
      return mapper.writeValueAsString(evaluation.summaryJson);
    }

    private JsonNode invokeRuntimeStatus(ObjectMapper mapper, String definitionKey, String requestId) throws Exception {
      String endpoint = switch (config.endpointMode) {
        case "internal" -> "/internal/canaries/run";
        case "action" -> "/hasura/actions/runtime-status";
        default -> throw new IllegalArgumentException("Unsupported endpoint mode: " + config.endpointMode);
      };
      URI uri = URI.create(trimTrailingSlash(config.runtimeStatusUrl) + endpoint);
      String body = buildRequestBody(mapper, definitionKey, requestId);

      HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(uri)
        .timeout(Duration.ofMillis(config.httpTimeoutMs))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));

      String token = config.resolveInternalToken();
      if (!token.isBlank()) {
        requestBuilder.header("Authorization", "Bearer " + token);
      } else if ("internal".equals(config.endpointMode)) {
        throw new IllegalStateException("endpoint-mode=internal requires --internal-token, --internal-token-file, or --internal-token-env");
      }

      HttpClient client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofMillis(config.connectTimeoutMs))
        .build();
      HttpResponse<String> response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
      JsonNode payload = parseJson(mapper, response.body());
      if (response.statusCode() < 200 || response.statusCode() > 299) {
        throw new IllegalStateException("runtime-status-service returned HTTP " + response.statusCode() + ": " + truncate(response.body(), 1000));
      }
      return payload;
    }

    private String buildRequestBody(ObjectMapper mapper, String definitionKey, String requestId) throws IOException {
      ObjectNode input = mapper.createObjectNode();
      input.put("definition_key", definitionKey);
      input.put("source", config.source);
      input.put("request_id", requestId);

      if ("internal".equals(config.endpointMode)) {
        return mapper.writeValueAsString(input);
      }

      input.put("action", "trigger");
      ObjectNode envelope = mapper.createObjectNode();
      envelope.set("input", input);
      return mapper.writeValueAsString(envelope);
    }

    private Evaluation evaluate(ObjectMapper mapper, String definitionKey, String requestId, JsonNode response) {
      List<JsonNode> results = extractResults(response);
      ObjectNode summary = mapper.createObjectNode();
      summary.put("definition_key", definitionKey);
      summary.put("request_id", requestId);
      summary.put("source", config.source);
      summary.put("endpoint_mode", config.endpointMode);
      summary.put("result_count", results.size());

      if (response == null || response.isMissingNode() || response.isNull()) {
        summary.put("status", "failed");
        summary.put("severity", "critical");
        summary.put("summary", "runtime-status-service returned an empty or non-JSON response.");
        return Evaluation.failed(summary.get("summary").asText(), summary);
      }
      if (response.has("ok") && !response.path("ok").asBoolean(false)) {
        String message = response.path("error").path("message").asText("runtime-status-service returned ok=false");
        summary.put("status", "failed");
        summary.put("severity", "critical");
        summary.put("summary", message);
        return Evaluation.failed(message, summary);
      }
      if (results.isEmpty()) {
        String message = "Canary run returned no results for definition '" + definitionKey + "'.";
        summary.put("status", "failed");
        summary.put("severity", "critical");
        summary.put("summary", message);
        return Evaluation.failed(message, summary);
      }

      List<String> failed = new ArrayList<>();
      List<String> warnings = new ArrayList<>();
      String overallStatus = "succeeded";
      String overallSeverity = "healthy";
      String runId = "";
      String runSummary = "";
      int totalStepCount = 0;

      for (JsonNode result : results) {
        JsonNode run = result.path("run");
        JsonNode steps = result.path("steps");
        int stepCount = steps.isArray() ? steps.size() : run.path("details_json").path("step_count").asInt(0);
        totalStepCount += stepCount;
        String status = normalize(run.path("status").asText("unknown"));
        String severity = normalize(run.path("severity").asText("unknown"));
        if (runId.isBlank()) {
          runId = run.path("id").asText("");
        }
        if (runSummary.isBlank()) {
          runSummary = run.path("summary").asText("");
        }

        if ("critical".equals(severity) || "failed".equals(status)) {
          failed.add(describeRun(run));
        } else if (config.requireSteps && stepCount == 0 && !"skipped".equals(status)) {
          failed.add(describeRun(run) + " produced zero executable steps");
        } else if ("warning".equals(severity)) {
          warnings.add(describeRun(run));
        }

        overallStatus = worseStatus(overallStatus, status);
        overallSeverity = worseSeverity(overallSeverity, severity);
      }

      summary.put("run_id", runId);
      summary.put("status", overallStatus);
      summary.put("severity", overallSeverity);
      summary.put("summary", runSummary.isBlank() ? "Canary run completed." : runSummary);
      summary.put("step_count", totalStepCount);
      summary.put("failed_count", failed.size());
      summary.put("warning_count", warnings.size());

      if (!failed.isEmpty()) {
        return Evaluation.failed(String.join("; ", failed), summary);
      }
      if (config.failOnWarning && !warnings.isEmpty()) {
        return Evaluation.failed(String.join("; ", warnings), summary);
      }
      if (config.failOnSkipped && "skipped".equals(overallStatus)) {
        return Evaluation.failed("Canary run was skipped.", summary);
      }
      return Evaluation.succeeded(summary);
    }

    private List<JsonNode> extractResults(JsonNode response) {
      List<JsonNode> results = new ArrayList<>();
      if (response == null || response.isMissingNode() || response.isNull()) {
        return results;
      }

      JsonNode array = response.path("results");
      if (array.isArray()) {
        Iterator<JsonNode> iterator = array.elements();
        while (iterator.hasNext()) {
          results.add(iterator.next());
        }
      }

      JsonNode singleResult = response.path("result");
      if (singleResult.isObject()) {
        results.add(singleResult);
      } else if (response.path("run").isObject()) {
        ObjectNode wrapper = new ObjectMapper().createObjectNode();
        wrapper.set("run", response.path("run"));
        wrapper.set("steps", response.path("steps"));
        results.add(wrapper);
      }
      return results;
    }

    private static JsonNode parseJson(ObjectMapper mapper, String body) throws IOException {
      if (body == null || body.isBlank()) {
        return mapper.nullNode();
      }
      return mapper.readTree(body);
    }

    private static String describeRun(JsonNode run) {
      String id = run.path("id").asText("");
      String status = run.path("status").asText("unknown");
      String severity = run.path("severity").asText("unknown");
      String summary = run.path("summary").asText("");
      String prefix = id.isBlank() ? "run" : "run " + id;
      return prefix + " status=" + status + " severity=" + severity + (summary.isBlank() ? "" : " summary=" + summary);
    }
  }

  record Evaluation(boolean ok, String summary, ObjectNode summaryJson) {
    static Evaluation succeeded(ObjectNode summaryJson) {
      return new Evaluation(true, summaryJson.path("summary").asText("Canary run succeeded."), summaryJson);
    }

    static Evaluation failed(String summary, ObjectNode summaryJson) {
      return new Evaluation(false, summary, summaryJson);
    }
  }

  static final class Config implements Serializable {
    @Serial
    private static final long serialVersionUID = 1L;

    final String runtimeStatusUrl;
    final String definitionKey;
    final String source;
    final String endpointMode;
    final String requestId;
    final String internalToken;
    final String internalTokenFile;
    final String internalTokenEnv;
    final int connectTimeoutMs;
    final int httpTimeoutMs;
    final boolean failOnWarning;
    final boolean failOnSkipped;
    final boolean requireSteps;

    Config(
      String runtimeStatusUrl,
      String definitionKey,
      String source,
      String endpointMode,
      String requestId,
      String internalToken,
      String internalTokenFile,
      String internalTokenEnv,
      int connectTimeoutMs,
      int httpTimeoutMs,
      boolean failOnWarning,
      boolean failOnSkipped,
      boolean requireSteps
    ) {
      this.runtimeStatusUrl = runtimeStatusUrl;
      this.definitionKey = definitionKey;
      this.source = source;
      this.endpointMode = endpointMode;
      this.requestId = requestId;
      this.internalToken = internalToken;
      this.internalTokenFile = internalTokenFile;
      this.internalTokenEnv = internalTokenEnv;
      this.connectTimeoutMs = connectTimeoutMs;
      this.httpTimeoutMs = httpTimeoutMs;
      this.failOnWarning = failOnWarning;
      this.failOnSkipped = failOnSkipped;
      this.requireSteps = requireSteps;
    }

    static Config fromArgs(String[] args) {
      Map<String, String> values = ArgParser.parse(args);
      return new Config(
        values.getOrDefault("runtime-status-url", "http://runtime-status-service.directus.svc.cluster.local:8080"),
        values.getOrDefault("definition-key", "cms.translation.pipeline.lightweight"),
        values.getOrDefault("source", "flink"),
        normalize(values.getOrDefault("endpoint-mode", "action")),
        values.getOrDefault("request-id", ""),
        values.getOrDefault("internal-token", ""),
        values.getOrDefault("internal-token-file", ""),
        values.getOrDefault("internal-token-env", ""),
        parseInt(values.get("connect-timeout-ms"), 5_000),
        parseInt(values.get("http-timeout-ms"), 60_000),
        parseBoolean(values.get("fail-on-warning"), false),
        parseBoolean(values.get("fail-on-skipped"), false),
        parseBoolean(values.get("require-steps"), true)
      );
    }

    String resolveInternalToken() throws IOException {
      if (!internalToken.isBlank()) {
        return internalToken;
      }
      if (!internalTokenFile.isBlank()) {
        return Files.readString(Path.of(internalTokenFile), StandardCharsets.UTF_8).trim();
      }
      if (!internalTokenEnv.isBlank()) {
        return System.getenv().getOrDefault(internalTokenEnv, "").trim();
      }
      return "";
    }
  }

  static final class ArgParser {
    private ArgParser() {
    }

    static Map<String, String> parse(String[] args) {
      java.util.LinkedHashMap<String, String> values = new java.util.LinkedHashMap<>();
      for (int i = 0; i < args.length; i += 1) {
        String arg = args[i];
        if (!arg.startsWith("--")) {
          continue;
        }
        String keyValue = arg.substring(2);
        int equals = keyValue.indexOf('=');
        if (equals >= 0) {
          values.put(keyValue.substring(0, equals), keyValue.substring(equals + 1));
        } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          values.put(keyValue, args[i + 1]);
          i += 1;
        } else {
          values.put(keyValue, "true");
        }
      }
      return values;
    }
  }

  private static int parseInt(String raw, int fallback) {
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    try {
      return Integer.parseInt(raw);
    } catch (NumberFormatException ignored) {
      return fallback;
    }
  }

  private static boolean parseBoolean(String raw, boolean fallback) {
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    return switch (normalize(raw)) {
      case "1", "true", "yes", "y", "on" -> true;
      case "0", "false", "no", "n", "off" -> false;
      default -> fallback;
    };
  }

  private static String normalize(String value) {
    return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
  }

  private static String trimTrailingSlash(String value) {
    String result = value == null || value.isBlank() ? "http://runtime-status-service.directus.svc.cluster.local:8080" : value.trim();
    while (result.endsWith("/")) {
      result = result.substring(0, result.length() - 1);
    }
    return result;
  }

  private static String worseStatus(String current, String candidate) {
    if ("failed".equals(candidate) || "failed".equals(current)) {
      return "failed";
    }
    if ("skipped".equals(candidate) || "skipped".equals(current)) {
      return "skipped";
    }
    if ("running".equals(candidate) || "running".equals(current)) {
      return "running";
    }
    return "succeeded";
  }

  private static String worseSeverity(String current, String candidate) {
    if ("critical".equals(candidate) || "critical".equals(current)) {
      return "critical";
    }
    if ("warning".equals(candidate) || "warning".equals(current)) {
      return "warning";
    }
    if ("unknown".equals(candidate) || "unknown".equals(current)) {
      return "unknown";
    }
    return "healthy";
  }

  private static String truncate(String value, int max) {
    if (value == null || value.length() <= max) {
      return value == null ? "" : value;
    }
    return value.substring(0, max) + "...";
  }
}
