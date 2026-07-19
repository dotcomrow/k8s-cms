FROM maven:3.9.11-eclipse-temurin-17 AS build
WORKDIR /workspace
COPY pom.xml ./
RUN mvn -B -ntp dependency:go-offline
COPY src ./src
RUN mvn -B -ntp package

FROM flink:1.20.3-scala_2.12-java17
USER root
COPY --from=build /workspace/target/runtime-status-flink-job-1.0.0.jar /opt/flink/usrlib/runtime-status-flink-job.jar
COPY run-runtime-status-canary.sh /opt/flink/bin/run-runtime-status-canary.sh
RUN chmod +x /opt/flink/bin/run-runtime-status-canary.sh && chown -R flink:flink /opt/flink/usrlib /opt/flink/bin/run-runtime-status-canary.sh
USER flink
ENTRYPOINT ["/opt/flink/bin/run-runtime-status-canary.sh"]
