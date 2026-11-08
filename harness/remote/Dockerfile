# 仅测试用的 SSH 远端：Ubuntu 22.04 + openssh-server。
# root/dev 弱口令只为本地与 CI 验证远程链路，镜像不发布、不可用于任何真实主机。
FROM ubuntu:22.04

# 稳定的依赖层单独成层并合并成一次 apt 调用：系统包没变时 BuildKit 直接复用，
# 后续口令/用户配置变化不会让 apt 重新执行。--no-install-recommends 控制体积，
# 装完清掉 apt 索引，避免把包列表写进镜像。
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
  && rm -rf /var/lib/apt/lists/*

# sshd 运行目录（Ubuntu 镜像里 /run 是空的，缺它 sshd 直接退出）。
RUN mkdir -p /var/run/sshd

# 允许 root 口令登录（仅测试）。CI 只把这些端口绑到 127.0.0.1，不暴露到公网。
RUN sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config \
  && printf '%s\n' 'PasswordAuthentication yes' >> /etc/ssh/sshd_config \
  && echo 'root:root' | chpasswd

# 普通用户 dev/dev，用来覆盖非 root 登录路径。
RUN useradd -m -s /bin/bash dev && echo 'dev:dev' | chpasswd

# 不清理环境变量，防止 ssh 登录时报错
RUN sed -i 's@session\s*required\s*pam_loginuid.so@session optional pam_loginuid.so@g' /etc/pam.d/sshd

# 暴露 ssh 默认端口
EXPOSE 22

# 启动 ssh 服务
CMD ["/usr/sbin/sshd", "-D"]
