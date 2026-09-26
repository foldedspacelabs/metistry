// Usage — what the models cost and which one each tier runs on: the compute
// report with its spend, the live model lists, and the two writes a remote
// client may also make — an assignment and a spending limit (design-build-plan
// §2.3, §2.16). Providers, keys and base URLs are the Mac's alone, through
// `metistry compute providers` (M16), never a route.

import Foundation

public protocol UsageStore: Sendable {
    /// route: GET /api/compute
    func compute() async -> Result<ConsoleCompute, ConsoleError>
    /// route: GET /api/compute/models
    func computeModels(provider: String?) async -> Result<ComputeModelsReply, ConsoleError>
    /// route: POST /api/compute/assign
    func assignCompute(_ target: ComputeAssignTarget, model: String, effort: String?) async -> Result<ComputeWriteResult, ConsoleError>
    /// route: POST /api/compute/budget
    func setComputeBudget(scope: String, daily: Double?, monthly: Double?, action: String) async -> Result<ComputeWriteResult, ConsoleError>
    /// route: POST /api/compute/providers/test
    func testComputeProvider(_ name: String, complete: Bool) async -> Result<ComputeProviderTestReply, ConsoleError>
}

extension ConsoleStores: UsageStore {
    public func compute() async -> Result<ConsoleCompute, ConsoleError> { await api.compute() }
    public func computeModels(provider: String?) async -> Result<ComputeModelsReply, ConsoleError> { await api.computeModels(provider: provider) }

    public func assignCompute(_ target: ComputeAssignTarget, model: String, effort: String?) async -> Result<ComputeWriteResult, ConsoleError> {
        await api.assignCompute(target, model: model, effort: effort)
    }

    public func setComputeBudget(scope: String, daily: Double?, monthly: Double?, action: String) async -> Result<ComputeWriteResult, ConsoleError> {
        await api.setComputeBudget(scope: scope, daily: daily, monthly: monthly, action: action)
    }

    public func testComputeProvider(_ name: String, complete: Bool) async -> Result<ComputeProviderTestReply, ConsoleError> {
        await api.testComputeProvider(name, complete: complete)
    }
}
